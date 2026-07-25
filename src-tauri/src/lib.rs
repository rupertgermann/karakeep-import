use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

pub mod bookmark;
pub mod delivery;
pub mod delivery_coordinator;
pub mod destination;
pub mod diagnostics;
pub mod diagnostics_save;
pub mod domain;
pub mod fieldtheory;
pub mod file_source;
pub mod karakeep;
pub mod ledger;
pub mod operation_gate;
pub mod private_data;
pub mod redaction;
pub mod settings;
pub mod transfer;
pub mod transfer_source;
pub mod updates;
pub mod versions;

use delivery_coordinator::{
    DeliveryCoordinator, DeliveryCoordinatorErrorCode, DeliveryEvent, DeliveryEventSink,
    DeliveryFailureCode, DeliveryId, DeliveryTerminalEvent,
};
use destination::{
    ConnectDestinationInput, DestinationError, DestinationErrorCode, DestinationService,
    DestinationSummary, FileDestinationSettings, NativeCredentialVault, ReqwestKarakeepClient,
};
use domain::DestinationIdentity;

use fieldtheory::{
    AcquisitionEvent, AcquisitionFailureCode, BridgeCommand, BridgeRequest, DestinationPreview,
    DiscoveryResponse, FieldTheoryState, SelectedXSource, XAcquisitionRequest, XSourceReference,
    XSourceSelection, XTransferPreview,
};
use operation_gate::{OperationGate, OperationKind};
use transfer_source::{
    TransferSourceErrorCode, TransferSourceRequest, deduplicated_preview_folders,
    resolve_transfer_source,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    app_name: &'static str,
    version: &'static str,
}

#[tauri::command]
fn health() -> HealthResponse {
    HealthResponse {
        status: "ok",
        app_name: "Karakeep Transfer",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn version_information() -> versions::ComponentVersions {
    versions::ComponentVersions::current()
}

#[tauri::command]
fn manual_update_check() -> updates::ManualUpdateCheckResult {
    updates::manual_update_check()
}

#[tauri::command]
fn export_diagnostics(
    state: tauri::State<'_, diagnostics::DiagnosticsStore>,
    field_theory: tauri::State<'_, FieldTheoryState>,
    destination: tauri::State<'_, DestinationState>,
    settings: tauri::State<'_, settings::SettingsService>,
) -> Result<diagnostics::DiagnosticsExport, &'static str> {
    current_diagnostics(&state, &field_theory, &destination, &settings)
}

#[tauri::command]
async fn save_diagnostics<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, diagnostics::DiagnosticsStore>,
    field_theory: tauri::State<'_, FieldTheoryState>,
    destination: tauri::State<'_, DestinationState>,
    settings: tauri::State<'_, settings::SettingsService>,
) -> Result<bool, &'static str> {
    let export = current_diagnostics(&state, &field_theory, &destination, &settings)?;
    let dialog = diagnostics_save::NativeDiagnosticsSaveDialog::new(app);

    tauri::async_runtime::spawn_blocking(move || {
        diagnostics_save::save_diagnostics_export(&dialog, &export)
    })
    .await
    .map_err(|_| "diagnostics could not be saved")?
    .map_err(diagnostics_save::DiagnosticsSaveError::public_message)
}

fn current_diagnostics(
    state: &diagnostics::DiagnosticsStore,
    field_theory: &FieldTheoryState,
    destination: &DestinationState,
    settings: &settings::SettingsService,
) -> Result<diagnostics::DiagnosticsExport, &'static str> {
    let (source_hint, destination_hint) = state.component_statuses()?;
    let source = if field_theory.has_snapshot() {
        diagnostics::ComponentStatus::Ready
    } else if source_hint == diagnostics::ComponentStatus::Unavailable {
        diagnostics::ComponentStatus::Unavailable
    } else {
        diagnostics::ComponentStatus::NotConfigured
    };
    let destination = match destination.0.status() {
        Ok(Some(_)) if destination_hint == diagnostics::ComponentStatus::Unavailable => {
            diagnostics::ComponentStatus::Unavailable
        }
        Ok(Some(_)) => diagnostics::ComponentStatus::Ready,
        Ok(None) if destination_hint == diagnostics::ComponentStatus::Unavailable => {
            diagnostics::ComponentStatus::Unavailable
        }
        Ok(None) => diagnostics::ComponentStatus::NotConfigured,
        Err(_) => diagnostics::ComponentStatus::Unavailable,
    };
    let storage = settings
        .inspect_private_data()
        .map_err(|_| "private transfer data is unavailable")?;
    let snapshot_bytes = field_theory
        .snapshot_bytes()
        .map_err(|_| "private transfer data is unavailable")?;
    state.explicit_export_with(
        source,
        destination,
        diagnostics::StorageSummary {
            data_directory: "private application data".to_owned(),
            snapshot_bytes,
            ledger_bytes: storage.ledger_bytes,
        },
    )
}

#[tauri::command]
fn discover_x_sources(
    state: tauri::State<'_, FieldTheoryState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticsStore>,
) -> Result<DiscoveryResponse, String> {
    let result = state
        .runner()
        .request(&BridgeRequest::new(
            "discover-x-sources",
            BridgeCommand::DiscoverSources,
        ))
        .map_err(|error| error.to_string());
    if result.is_err() {
        let _ = diagnostics.record_source_failure(diagnostics::DiagnosticFailure::BrowserAccess);
    }
    result
}

#[tauri::command]
fn select_x_source(
    state: tauri::State<'_, FieldTheoryState>,
    selections: tauri::State<'_, XSelectionState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticsStore>,
    request: XSourceSelection,
) -> Result<SelectedXSource, String> {
    let source = request.source.clone();
    let result = state
        .runner()
        .request(&BridgeRequest::select("select-x-source", request))
        .map_err(|error| error.to_string());
    if result.is_ok() {
        selections.select(source)?;
    }
    if result.is_err() {
        let _ = diagnostics.record_source_failure(diagnostics::DiagnosticFailure::BrowserAccess);
    }
    result
}

#[derive(Default)]
struct XSelectionState(Mutex<Option<XSourceReference>>);

impl XSelectionState {
    fn select(&self, source: XSourceReference) -> Result<(), String> {
        *self
            .0
            .lock()
            .map_err(|_| "X Source selection is unavailable.".to_string())? = Some(source);
        Ok(())
    }

    fn authorize(&self, source: &XSourceReference) -> Result<(), String> {
        let selected = self
            .0
            .lock()
            .map_err(|_| "X Source selection is unavailable.".to_string())?;
        if selected.as_ref() == Some(source) {
            Ok(())
        } else {
            Err("Select this X Source and confirm consent before acquisition.".to_string())
        }
    }

    fn clear(&self) -> Result<(), String> {
        *self
            .0
            .lock()
            .map_err(|_| "X Source selection is unavailable.".to_string())? = None;
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSourceCommandError {
    code: &'static str,
    message: &'static str,
}

#[derive(Default)]
struct FileSelectionState(Mutex<Option<PathBuf>>);

impl FileSelectionState {
    fn select(&self, path: PathBuf) -> Result<(), FileSourceCommandError> {
        if !path.is_file() {
            return Err(file_unreadable());
        }
        *self.0.lock().map_err(|_| file_unreadable())? = Some(path);
        Ok(())
    }

    fn authorize(&self, path: &Path) -> Result<(), FileSourceCommandError> {
        let selected = self.0.lock().map_err(|_| file_unreadable())?;
        if selected.as_deref() == Some(path) {
            Ok(())
        } else {
            Err(file_unreadable())
        }
    }
}

fn file_unreadable() -> FileSourceCommandError {
    FileSourceCommandError {
        code: "fileUnreadable",
        message: "The selected file could not be read.",
    }
}

#[tauri::command]
async fn select_file_source<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    selections: tauri::State<'_, FileSelectionState>,
) -> Result<Option<PathBuf>, FileSourceCommandError> {
    let Some(selection) = app
        .dialog()
        .file()
        .add_filter("Bookmark files", &["jsonl", "json", "html", "htm", "txt"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selection.into_path().map_err(|_| file_unreadable())?;
    selections.select(path.clone())?;
    Ok(Some(path))
}

fn preview_selected_file_source(
    selections: &FileSelectionState,
    path: &Path,
    format: file_source::FileSourceFormat,
) -> Result<file_source::FileSourcePreview, FileSourceCommandError> {
    selections.authorize(path)?;
    file_source::preview_file(path, format).map_err(|_| FileSourceCommandError {
        code: "invalidFileSource",
        message: "The selected file is not a valid supported File Source.",
    })
}

#[tauri::command]
fn preview_file_source(
    selections: tauri::State<'_, FileSelectionState>,
    path: PathBuf,
    format: file_source::FileSourceFormat,
) -> Result<file_source::FileSourcePreview, FileSourceCommandError> {
    preview_selected_file_source(&selections, &path, format)
}

type NativeDestinationService =
    DestinationService<ReqwestKarakeepClient, NativeCredentialVault, FileDestinationSettings>;

trait DestinationConnection: Send + Sync {
    fn status(&self) -> Result<Option<DestinationSummary>, DestinationError>;
    fn connect(
        &self,
        input: ConnectDestinationInput,
    ) -> Result<DestinationSummary, DestinationError>;
    fn forget(&self) -> Result<(), DestinationError>;
    fn delivery_api(&self) -> Result<Arc<dyn karakeep::KarakeepApi>, DestinationError>;
}

impl DestinationConnection for NativeDestinationService {
    fn status(&self) -> Result<Option<DestinationSummary>, DestinationError> {
        DestinationService::status(self)
    }

    fn connect(
        &self,
        input: ConnectDestinationInput,
    ) -> Result<DestinationSummary, DestinationError> {
        DestinationService::connect(self, input)
    }

    fn forget(&self) -> Result<(), DestinationError> {
        DestinationService::forget(self)
    }

    fn delivery_api(&self) -> Result<Arc<dyn karakeep::KarakeepApi>, DestinationError> {
        DestinationService::delivery_api(self)
    }
}

struct DestinationState(Arc<dyn DestinationConnection>);

#[tauri::command]
async fn destination_status(
    state: tauri::State<'_, DestinationState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticsStore>,
) -> Result<Option<DestinationSummary>, DestinationError> {
    let service = Arc::clone(&state.0);
    let result = tauri::async_runtime::spawn_blocking(move || service.status())
        .await
        .unwrap_or_else(|_| Err(DestinationError::for_code(DestinationErrorCode::Storage)));
    match &result {
        Ok(Some(_)) => {
            let _ = diagnostics.set_destination_status(diagnostics::ComponentStatus::Ready);
        }
        Ok(None) => {
            let _ = diagnostics.set_destination_status(diagnostics::ComponentStatus::NotConfigured);
        }
        Err(error) => record_destination_diagnostic(&diagnostics, error.code()),
    }
    result
}

#[tauri::command]
async fn connect_destination(
    input: ConnectDestinationInput,
    state: tauri::State<'_, DestinationState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticsStore>,
) -> Result<DestinationSummary, DestinationError> {
    let service = Arc::clone(&state.0);
    let result = tauri::async_runtime::spawn_blocking(move || service.connect(input))
        .await
        .unwrap_or_else(|_| Err(DestinationError::for_code(DestinationErrorCode::Network)));
    match &result {
        Ok(_) => {
            let _ = diagnostics.set_destination_status(diagnostics::ComponentStatus::Ready);
        }
        Err(error) => record_destination_diagnostic(&diagnostics, error.code()),
    }
    result
}

#[tauri::command]
async fn forget_destination(
    state: tauri::State<'_, DestinationState>,
    transfers: tauri::State<'_, TransferState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticsStore>,
) -> Result<(), DestinationError> {
    let operation = transfers
        .operations
        .reserve(OperationKind::Maintenance)
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))?;
    let service = Arc::clone(&state.0);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        service.forget()
    })
    .await
    .unwrap_or_else(|_| Err(DestinationError::for_code(DestinationErrorCode::Storage)));
    match &result {
        Ok(()) => {
            let _ = diagnostics.set_destination_status(diagnostics::ComponentStatus::NotConfigured);
        }
        Err(error) => record_destination_diagnostic(&diagnostics, error.code()),
    }
    result
}

fn record_destination_diagnostic(
    diagnostics: &diagnostics::DiagnosticsStore,
    code: DestinationErrorCode,
) {
    let failure = match code {
        DestinationErrorCode::Authentication => {
            Some(diagnostics::DiagnosticFailure::DestinationAuthentication)
        }
        DestinationErrorCode::MissingCapability | DestinationErrorCode::UnsupportedDestination => {
            Some(diagnostics::DiagnosticFailure::DestinationCompatibility)
        }
        DestinationErrorCode::Network => Some(diagnostics::DiagnosticFailure::Network),
        DestinationErrorCode::InsecureDestination
        | DestinationErrorCode::InvalidServerUrl
        | DestinationErrorCode::Storage => None,
    };
    if let Some(failure) = failure {
        let _ = diagnostics.record_destination_failure(failure);
    }
}

#[tauri::command]
fn inspect_private_transfer_data(
    state: tauri::State<'_, settings::SettingsService>,
) -> Result<settings::SettingsPrivateDataSummary, &'static str> {
    state
        .inspect_private_data()
        .map_err(|_| "private transfer data is unavailable")
}

#[tauri::command]
fn replace_x_source(
    state: tauri::State<'_, settings::SettingsService>,
    selections: tauri::State<'_, XSelectionState>,
    transfers: tauri::State<'_, TransferState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticsStore>,
    confirmation: settings::ReplaceXSourceConfirmation,
) -> Result<(), &'static str> {
    let _operation = transfers
        .operations
        .reserve(OperationKind::Maintenance)
        .map_err(|_| "local transfer data is in use")?;
    let result = state
        .replace_x_source(confirmation.capability())
        .map_err(|_| "X source data could not be replaced");
    if result.is_ok() {
        let _ = selections.clear();
        let _ = diagnostics.set_source_status(diagnostics::ComponentStatus::NotConfigured);
    }
    result
}

#[tauri::command]
fn delete_local_transfer_data(
    state: tauri::State<'_, settings::SettingsService>,
    selections: tauri::State<'_, XSelectionState>,
    transfers: tauri::State<'_, TransferState>,
    diagnostics: tauri::State<'_, diagnostics::DiagnosticsStore>,
    confirmation: settings::DeleteLocalTransferDataConfirmation,
) -> Result<(), &'static str> {
    let _operation = transfers
        .operations
        .reserve(OperationKind::Maintenance)
        .map_err(|_| "local transfer data is in use")?;
    transfers.close_ledger()?;
    transfers.clear_file_approval()?;
    let result = state
        .delete_local_transfer_data(confirmation.capability())
        .map_err(|_| "local transfer data could not be deleted");
    if result.is_ok() {
        let _ = selections.clear();
        let _ = diagnostics.set_source_status(diagnostics::ComponentStatus::NotConfigured);
    }
    result
}

#[tauri::command]
fn start_x_acquisition<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, FieldTheoryState>,
    selections: tauri::State<'_, XSelectionState>,
    transfers: tauri::State<'_, TransferState>,
    request: XAcquisitionRequest,
) -> Result<(), String> {
    selections.authorize(&request.source)?;
    let operation = transfers
        .operations
        .reserve(OperationKind::Acquisition)
        .map_err(|_| "another transfer operation is already active".to_owned())?;
    let operation = Arc::new(Mutex::new(Some(operation)));
    let terminal_operation = Arc::clone(&operation);
    state
        .start_acquisition(request, move |event| {
            let diagnostics = app.state::<diagnostics::DiagnosticsStore>();
            match &event {
                AcquisitionEvent::Completed { .. } => {
                    let _ = diagnostics.set_source_status(diagnostics::ComponentStatus::Ready);
                }
                AcquisitionEvent::Failed { code, .. } => {
                    let failure = match code {
                        AcquisitionFailureCode::XCompatibility => {
                            diagnostics::DiagnosticFailure::XCompatibility
                        }
                        AcquisitionFailureCode::SourceUnavailable => {
                            diagnostics::DiagnosticFailure::BrowserAccess
                        }
                        AcquisitionFailureCode::Unexpected => {
                            diagnostics::DiagnosticFailure::XCompatibility
                        }
                    };
                    let _ = diagnostics.record_source_failure(failure);
                }
                AcquisitionEvent::Progress { .. }
                | AcquisitionEvent::Cancelled { .. }
                | AcquisitionEvent::Resumable { .. } => {}
            }
            let terminal = matches!(
                event,
                AcquisitionEvent::Completed { .. }
                    | AcquisitionEvent::Resumable { .. }
                    | AcquisitionEvent::Cancelled { .. }
                    | AcquisitionEvent::Failed { .. }
            );
            let _ = app.emit("x-acquisition", event);
            if terminal {
                let _ = terminal_operation
                    .lock()
                    .map(|mut operation| operation.take());
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_x_acquisition(
    state: tauri::State<'_, FieldTheoryState>,
    acquisition_id: String,
) -> Result<(), String> {
    state
        .cancel_acquisition(&acquisition_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn preview_x_snapshot(
    state: tauri::State<'_, FieldTheoryState>,
    destination: DestinationPreview,
) -> Result<XTransferPreview, String> {
    state
        .preview(destination)
        .map_err(|error| error.to_string())
}

struct TransferState {
    approved_file_source: Mutex<Option<ApprovedFileSource>>,
    coordinator: Mutex<Option<Arc<DeliveryCoordinator>>>,
    ledger_path: PathBuf,
    next_file_approval: AtomicU64,
    operations: OperationGate,
}

#[derive(Clone)]
struct ApprovedFileSource {
    approval_id: String,
    destination: DestinationIdentity,
    preview: file_source::FileSourcePreview,
    source: TransferSourceRequest,
}

impl TransferState {
    fn new(ledger_path: PathBuf) -> Self {
        Self {
            approved_file_source: Mutex::new(None),
            coordinator: Mutex::new(None),
            ledger_path,
            next_file_approval: AtomicU64::new(1),
            operations: OperationGate::default(),
        }
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let ledger = ledger::DeliveryLedger::open_in_memory().expect("in-memory delivery ledger");
        Self {
            approved_file_source: Mutex::new(None),
            coordinator: Mutex::new(Some(Arc::new(DeliveryCoordinator::new(Arc::new(
                Mutex::new(ledger),
            ))))),
            ledger_path: PathBuf::new(),
            next_file_approval: AtomicU64::new(1),
            operations: OperationGate::default(),
        }
    }

    fn approve_file_source(
        &self,
        source: &TransferSourceRequest,
        preview: &file_source::FileSourcePreview,
        destination: &DestinationIdentity,
    ) -> Result<Option<String>, TransferCommandError> {
        if !matches!(source, TransferSourceRequest::File { .. }) {
            return Ok(None);
        }
        let approval_id = format!(
            "file-approval-{}",
            self.next_file_approval.fetch_add(1, Ordering::Relaxed)
        );
        *self.approved_file_source.lock().map_err(|_| {
            TransferCommandError::for_code(TransferCommandErrorCode::DeliveryFailed)
        })? = Some(ApprovedFileSource {
            approval_id: approval_id.clone(),
            destination: destination.clone(),
            preview: preview.clone(),
            source: source.clone(),
        });
        Ok(Some(approval_id))
    }

    fn approved_file_preview(
        &self,
        approval_id: Option<&str>,
        source: &TransferSourceRequest,
        destination: &DestinationIdentity,
    ) -> Result<file_source::FileSourcePreview, TransferCommandError> {
        let approved = self.approved_file_source.lock().map_err(|_| {
            TransferCommandError::for_code(TransferCommandErrorCode::DeliveryFailed)
        })?;
        approved
            .as_ref()
            .filter(|approved| {
                Some(approved.approval_id.as_str()) == approval_id
                    && &approved.source == source
                    && &approved.destination == destination
            })
            .map(|approved| approved.preview.clone())
            .ok_or_else(|| {
                TransferCommandError::for_code(TransferCommandErrorCode::SourceUnavailable)
            })
    }

    fn coordinator(&self) -> Result<Arc<DeliveryCoordinator>, TransferCommandError> {
        let mut coordinator = self.coordinator.lock().map_err(|_| {
            TransferCommandError::for_code(TransferCommandErrorCode::DeliveryFailed)
        })?;
        if let Some(coordinator) = coordinator.as_ref() {
            return Ok(Arc::clone(coordinator));
        }
        let ledger = ledger::DeliveryLedger::open(&self.ledger_path).map_err(|_| {
            TransferCommandError::for_code(TransferCommandErrorCode::DeliveryFailed)
        })?;
        let next = Arc::new(DeliveryCoordinator::new(Arc::new(Mutex::new(ledger))));
        *coordinator = Some(Arc::clone(&next));
        Ok(next)
    }

    fn close_ledger(&self) -> Result<(), &'static str> {
        let mut coordinator = self
            .coordinator
            .lock()
            .map_err(|_| "local transfer data is unavailable")?;
        *coordinator = None;
        Ok(())
    }

    fn clear_file_approval(&self) -> Result<(), &'static str> {
        let mut approved = self
            .approved_file_source
            .lock()
            .map_err(|_| "local transfer data is unavailable")?;
        *approved = None;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartDeliveryRequest {
    approval_id: Option<String>,
    delivery_id: String,
    source: TransferSourceRequest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum TransferCommandErrorCode {
    DestinationAuthentication,
    DestinationCompatibility,
    DeliveryFailed,
    Network,
    SourceUnavailable,
    Unexpected,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferCommandError {
    code: TransferCommandErrorCode,
    message: &'static str,
}

impl TransferCommandError {
    fn for_code(code: TransferCommandErrorCode) -> Self {
        let message = match code {
            TransferCommandErrorCode::DestinationAuthentication => {
                "Reconnect Karakeep before continuing."
            }
            TransferCommandErrorCode::DestinationCompatibility => {
                "This Karakeep destination is missing a required delivery capability."
            }
            TransferCommandErrorCode::DeliveryFailed => {
                "The bookmark delivery operation could not be completed."
            }
            TransferCommandErrorCode::Network => {
                "Karakeep could not be reached. Check the connection and try again."
            }
            TransferCommandErrorCode::SourceUnavailable => {
                "The selected bookmark source is unavailable."
            }
            TransferCommandErrorCode::Unexpected => {
                "The transfer operation could not be completed."
            }
        };
        Self { code, message }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferPreview {
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_id: Option<String>,
    total: usize,
    pending: usize,
    previously_delivered: usize,
    folders: Vec<String>,
    destination: DestinationPreview,
}

#[derive(Clone)]
struct TauriDeliveryEventSink<R: tauri::Runtime>(tauri::AppHandle<R>);

impl<R: tauri::Runtime> DeliveryEventSink for TauriDeliveryEventSink<R> {
    fn publish(&self, event: DeliveryEvent) {
        if let DeliveryEvent::Terminal(DeliveryTerminalEvent::Failed { code, .. }) = &event {
            let failure = match code {
                DeliveryFailureCode::DestinationAuthentication => {
                    Some(diagnostics::DiagnosticFailure::DestinationAuthentication)
                }
                DeliveryFailureCode::DestinationCompatibility => {
                    Some(diagnostics::DiagnosticFailure::DestinationCompatibility)
                }
                DeliveryFailureCode::Network => Some(diagnostics::DiagnosticFailure::Network),
                DeliveryFailureCode::DeliveryFailed | DeliveryFailureCode::Unexpected => None,
            };
            if let Some(failure) = failure {
                let _ = self
                    .0
                    .state::<diagnostics::DiagnosticsStore>()
                    .record_destination_failure(failure);
            }
        }
        let _ = self.0.emit("delivery", event);
    }
}

fn connected_destination(
    service: &dyn DestinationConnection,
) -> Result<(DestinationSummary, DestinationIdentity), TransferCommandError> {
    let summary = service
        .status()
        .map_err(map_destination_error)?
        .ok_or_else(|| {
            TransferCommandError::for_code(TransferCommandErrorCode::DestinationAuthentication)
        })?;
    let identity = DestinationIdentity::new(&summary.server_url, &summary.user_id)
        .map_err(|_| TransferCommandError::for_code(TransferCommandErrorCode::Unexpected))?;
    Ok((summary, identity))
}

#[tauri::command]
fn preview_transfer(
    source: TransferSourceRequest,
    selections: tauri::State<'_, FileSelectionState>,
    field_theory: tauri::State<'_, FieldTheoryState>,
    destination: tauri::State<'_, DestinationState>,
    transfers: tauri::State<'_, TransferState>,
) -> Result<TransferPreview, TransferCommandError> {
    let (destination_summary, destination_identity) =
        connected_destination(destination.0.as_ref())?;
    if let TransferSourceRequest::File { path, .. } = &source {
        selections.authorize(path).map_err(|_| {
            TransferCommandError::for_code(TransferCommandErrorCode::SourceUnavailable)
        })?;
    }
    let preview =
        resolve_transfer_source(&source, &field_theory).map_err(map_transfer_source_error)?;
    let counts = transfers
        .coordinator()?
        .preview(&preview, &destination_identity)
        .map_err(map_coordinator_error)?;
    let approval_id = transfers.approve_file_source(&source, &preview, &destination_identity)?;
    Ok(TransferPreview {
        approval_id,
        total: counts.total,
        pending: counts.pending,
        previously_delivered: counts.previously_delivered,
        folders: deduplicated_preview_folders(&preview),
        destination: DestinationPreview {
            server_url: destination_summary.server_url,
            user_id: destination_summary.user_id,
            user_name: destination_summary.display_name,
        },
    })
}

#[tauri::command]
fn start_delivery<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: StartDeliveryRequest,
    field_theory: tauri::State<'_, FieldTheoryState>,
    destination: tauri::State<'_, DestinationState>,
    transfers: tauri::State<'_, TransferState>,
) -> Result<(), TransferCommandError> {
    let delivery_id = DeliveryId::new(request.delivery_id).map_err(map_coordinator_error)?;
    let operation = transfers
        .operations
        .reserve(OperationKind::Delivery)
        .map_err(|_| TransferCommandError::for_code(TransferCommandErrorCode::DeliveryFailed))?;
    let (_, destination_identity) = connected_destination(destination.0.as_ref())?;
    let api = destination
        .0
        .delivery_api()
        .map_err(map_destination_error)?;
    let preview = match &request.source {
        TransferSourceRequest::X => resolve_transfer_source(&request.source, &field_theory)
            .map_err(map_transfer_source_error)?,
        TransferSourceRequest::File { .. } => transfers.approved_file_preview(
            request.approval_id.as_deref(),
            &request.source,
            &destination_identity,
        )?,
    };
    let sink: Arc<dyn DeliveryEventSink> = Arc::new(TauriDeliveryEventSink(app));
    let coordinator = transfers.coordinator()?;
    let run = coordinator
        .prepare_run(api, delivery_id, preview, destination_identity, sink)
        .map_err(map_coordinator_error)?;
    let _task = tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        run.execute();
    });
    Ok(())
}

#[tauri::command]
fn cancel_delivery(
    delivery_id: String,
    transfers: tauri::State<'_, TransferState>,
) -> Result<(), TransferCommandError> {
    let delivery_id = DeliveryId::new(delivery_id).map_err(map_coordinator_error)?;
    transfers
        .coordinator()?
        .cancel(&delivery_id)
        .map_err(map_coordinator_error)
}

fn map_destination_error(error: DestinationError) -> TransferCommandError {
    let code = match error.code() {
        DestinationErrorCode::Authentication => TransferCommandErrorCode::DestinationAuthentication,
        DestinationErrorCode::MissingCapability | DestinationErrorCode::UnsupportedDestination => {
            TransferCommandErrorCode::DestinationCompatibility
        }
        DestinationErrorCode::Network => TransferCommandErrorCode::Network,
        DestinationErrorCode::InsecureDestination
        | DestinationErrorCode::InvalidServerUrl
        | DestinationErrorCode::Storage => TransferCommandErrorCode::Unexpected,
    };
    TransferCommandError::for_code(code)
}

fn map_transfer_source_error(error: transfer_source::TransferSourceError) -> TransferCommandError {
    let code = match error.code() {
        TransferSourceErrorCode::XSourceUnavailable
        | TransferSourceErrorCode::FileUnreadable
        | TransferSourceErrorCode::InvalidFileSource => TransferCommandErrorCode::SourceUnavailable,
    };
    TransferCommandError::for_code(code)
}

fn map_coordinator_error(
    error: delivery_coordinator::DeliveryCoordinatorError,
) -> TransferCommandError {
    let code = match error.code {
        DeliveryCoordinatorErrorCode::LedgerUnavailable
        | DeliveryCoordinatorErrorCode::AlreadyActive
        | DeliveryCoordinatorErrorCode::NoActiveDelivery
        | DeliveryCoordinatorErrorCode::DeliveryIdMismatch => {
            TransferCommandErrorCode::DeliveryFailed
        }
        DeliveryCoordinatorErrorCode::InvalidDeliveryId
        | DeliveryCoordinatorErrorCode::InvalidConfiguration
        | DeliveryCoordinatorErrorCode::StateUnavailable => TransferCommandErrorCode::Unexpected,
    };
    TransferCommandError::for_code(code)
}

fn configure_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(diagnostics::DiagnosticsStore::default())
        .manage(FileSelectionState::default())
        .manage(XSelectionState::default())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let app_data_directory = app.path().app_data_dir()?;
            app.manage(FieldTheoryState::bundled(
                &resource_dir,
                &app_data_directory,
            ));
            app.manage(TransferState::new(
                app_data_directory.join("delivery-ledger.sqlite3"),
            ));
            let settings_path = app.path().app_config_dir()?.join("destination.json");
            let service = DestinationService::new(
                ReqwestKarakeepClient::new(),
                NativeCredentialVault::new()?,
                FileDestinationSettings::new(settings_path),
            );
            app.manage(DestinationState(Arc::new(service)));
            app.manage(settings::SettingsService::from_app_data_dir(
                app_data_directory,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            version_information,
            manual_update_check,
            export_diagnostics,
            save_diagnostics,
            discover_x_sources,
            select_x_source,
            select_file_source,
            preview_file_source,
            destination_status,
            connect_destination,
            forget_destination,
            inspect_private_transfer_data,
            replace_x_source,
            delete_local_transfer_data,
            start_x_acquisition,
            cancel_x_acquisition,
            preview_x_snapshot,
            preview_transfer,
            start_delivery,
            cancel_delivery
        ])
}

pub fn run() {
    configure_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Karakeep Transfer");
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    use serde_json::{Value, json};
    use tauri::{
        App, Listener, Manager, WebviewWindow, WebviewWindowBuilder,
        test::{
            INVOKE_KEY, MockRuntime, assert_ipc_response, get_ipc_response, mock_builder,
            mock_context, noop_assets,
        },
        webview::InvokeRequest,
    };
    use tempfile::{TempDir, tempdir};

    struct DisconnectedDestination;

    #[derive(Default)]
    struct SuccessfulDeliveryApi {
        creates: AtomicUsize,
        notes: Mutex<Vec<Option<String>>>,
    }

    impl super::karakeep::KarakeepApi for SuccessfulDeliveryApi {
        fn ensure_bookmark(
            &self,
            draft: &super::karakeep::BookmarkDraft,
            _cancellation: &dyn super::karakeep::RequestCancellation,
        ) -> Result<super::karakeep::EnsuredBookmark, super::karakeep::ApiError> {
            self.notes
                .lock()
                .expect("captured notes")
                .push(draft.note.clone());
            let number = self.creates.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(super::karakeep::EnsuredBookmark {
                bookmark: super::karakeep::KarakeepBookmark {
                    id: format!("created-{number}"),
                    human_tags: Vec::new(),
                },
                origin: super::karakeep::BookmarkOrigin::Created,
            })
        }

        fn attach_tags(
            &self,
            _bookmark_id: &str,
            _tags: &[String],
            _cancellation: &dyn super::karakeep::RequestCancellation,
        ) -> Result<(), super::karakeep::ApiError> {
            Ok(())
        }
    }

    struct ConnectedDestination(Arc<SuccessfulDeliveryApi>);

    impl super::DestinationConnection for ConnectedDestination {
        fn status(&self) -> Result<Option<super::DestinationSummary>, super::DestinationError> {
            Ok(Some(super::DestinationSummary {
                server_url: "https://keep.example".into(),
                user_id: "user-1".into(),
                display_name: "Test Reader".into(),
                email: None,
                insecure_http: false,
            }))
        }

        fn connect(
            &self,
            _input: super::ConnectDestinationInput,
        ) -> Result<super::DestinationSummary, super::DestinationError> {
            self.status()?.ok_or_else(|| {
                super::DestinationError::for_code(super::DestinationErrorCode::Authentication)
            })
        }

        fn forget(&self) -> Result<(), super::DestinationError> {
            Ok(())
        }

        fn delivery_api(
            &self,
        ) -> Result<Arc<dyn super::karakeep::KarakeepApi>, super::DestinationError> {
            Ok(self.0.clone())
        }
    }

    impl super::DestinationConnection for DisconnectedDestination {
        fn status(&self) -> Result<Option<super::DestinationSummary>, super::DestinationError> {
            Ok(None)
        }

        fn connect(
            &self,
            _input: super::ConnectDestinationInput,
        ) -> Result<super::DestinationSummary, super::DestinationError> {
            Err(super::DestinationError::for_code(
                super::DestinationErrorCode::Authentication,
            ))
        }

        fn forget(&self) -> Result<(), super::DestinationError> {
            Ok(())
        }

        fn delivery_api(
            &self,
        ) -> Result<Arc<dyn super::karakeep::KarakeepApi>, super::DestinationError> {
            Err(super::DestinationError::for_code(
                super::DestinationErrorCode::Authentication,
            ))
        }
    }

    fn test_transfer_state() -> super::TransferState {
        super::TransferState::in_memory()
    }

    fn command_response(command: &str, body: tauri::ipc::InvokeBody) -> Result<Value, Value> {
        let directory = tempdir().expect("temporary app state");
        let app = super::configure_builder(mock_builder())
            .manage(super::FieldTheoryState::bundled(
                directory.path(),
                directory.path(),
            ))
            .manage(super::DestinationState(Arc::new(DisconnectedDestination)))
            .manage(super::settings::SettingsService::from_app_data_dir(
                directory.path(),
            ))
            .manage(test_transfer_state())
            .build(mock_context(noop_assets()))
            .expect("mock app builds");
        if let tauri::ipc::InvokeBody::Json(value) = &body
            && let Some(path) = value
                .get("path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .filter(|path| path.is_file())
        {
            app.state::<super::FileSelectionState>()
                .select(path)
                .expect("test fixture is selected");
        }
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview builds");

        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("valid IPC origin"),
                body,
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|response| response.deserialize::<Value>().expect("response is JSON"))
    }

    struct FileDeliveryHarness {
        _directory: TempDir,
        api: Arc<SuccessfulDeliveryApi>,
        app: App<MockRuntime>,
        approval_id: String,
        approved_contents: String,
        delivered: mpsc::Receiver<String>,
        request_body: Value,
        reviewed_preview: Value,
        source: PathBuf,
        webview: WebviewWindow<MockRuntime>,
    }

    impl FileDeliveryHarness {
        fn new() -> Self {
            let directory = tempdir().expect("temporary app state");
            let source = directory.path().join("selected-bookmarks.jsonl");
            let approved_contents = fs::read_to_string(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/field-theory-one.jsonl"),
            )
            .expect("approved fixture");
            fs::write(&source, &approved_contents).expect("selected source");
            let api = Arc::new(SuccessfulDeliveryApi::default());
            let app = super::configure_builder(mock_builder())
                .manage(super::FieldTheoryState::bundled(
                    directory.path(),
                    directory.path(),
                ))
                .manage(super::DestinationState(Arc::new(ConnectedDestination(
                    api.clone(),
                ))))
                .manage(test_transfer_state())
                .build(mock_context(noop_assets()))
                .expect("mock app builds");
            app.state::<super::FileSelectionState>()
                .select(source.clone())
                .expect("test fixture is selected");
            let (events, delivered) = mpsc::channel();
            app.listen("delivery", move |event| {
                let _ = events.send(event.payload().to_owned());
            });
            let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .expect("mock webview builds");
            let request_body = json!({
                "source": {
                    "kind": "file",
                    "path": source,
                    "format": "fieldTheoryJsonl"
                }
            });
            let reviewed_preview =
                Self::invoke(&webview, "preview_transfer", request_body.clone().into())
                    .expect("preview succeeds");
            let approval_id = reviewed_preview["approvalId"]
                .as_str()
                .expect("opaque approval ID")
                .to_owned();

            Self {
                _directory: directory,
                api,
                app,
                approval_id,
                approved_contents,
                delivered,
                request_body,
                reviewed_preview,
                source,
                webview,
            }
        }

        fn invoke(
            webview: &WebviewWindow<MockRuntime>,
            command: &str,
            body: tauri::ipc::InvokeBody,
        ) -> Result<Value, Value> {
            get_ipc_response(
                webview,
                InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().expect("valid IPC origin"),
                    body,
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .map(|response| response.deserialize::<Value>().expect("response is JSON"))
        }

        fn start(&self, delivery_id: &str, approval_id: &str) -> Result<Value, Value> {
            Self::invoke(
                &self.webview,
                "start_delivery",
                json!({
                    "request": {
                        "approvalId": approval_id,
                        "deliveryId": delivery_id,
                        "source": self.request_body["source"].clone()
                    }
                })
                .into(),
            )
        }

        fn preview_again(&self) -> Result<Value, Value> {
            Self::invoke(
                &self.webview,
                "preview_transfer",
                self.request_body.clone().into(),
            )
        }

        fn change_source_after_review(&self) {
            fs::write(
                &self.source,
                self.approved_contents
                    .replace("A useful post", "Changed after review"),
            )
            .expect("source changes after preview");
        }

        fn wait_for_terminal(&self, delivery_id: &str) -> Value {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .expect("delivery terminal event before timeout");
                let payload = self
                    .delivered
                    .recv_timeout(remaining)
                    .expect("delivery event");
                let value: Value = serde_json::from_str(&payload).expect("event JSON");
                if value["deliveryId"] == delivery_id
                    && matches!(
                        value["type"].as_str(),
                        Some("completed" | "cancelled" | "failed")
                    )
                {
                    return value;
                }
            }
        }

        fn wait_for_operation_release(&self) {
            let deadline = Instant::now() + Duration::from_secs(2);
            while self
                .app
                .state::<super::TransferState>()
                .operations
                .is_active()
            {
                assert!(
                    Instant::now() < deadline,
                    "completed delivery releases the operation"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }

    fn assert_command_response_with_body(
        command: &str,
        body: tauri::ipc::InvokeBody,
        expected: Result<Value, Value>,
    ) {
        assert_eq!(command_response(command, body), expected);
    }

    fn assert_command_response(command: &str, expected: Value) {
        assert_command_response_with_body(command, tauri::ipc::InvokeBody::default(), Ok(expected));
    }

    fn assert_settings_confirmation_command(
        command: &str,
        confirmation: &str,
        directory: &std::path::Path,
    ) {
        let app = super::configure_builder(mock_builder())
            .manage(super::settings::SettingsService::from_app_data_dir(
                directory,
            ))
            .manage(test_transfer_state())
            .build(mock_context(noop_assets()))
            .expect("mock app builds");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview builds");

        assert_ipc_response(
            &webview,
            InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("valid IPC origin"),
                body: json!({ "confirmation": confirmation }).into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
            Ok::<_, Value>(Value::Null),
        );
    }

    #[test]
    fn health_response_is_the_typed_desktop_contract() {
        assert_command_response(
            "health",
            json!({
                "status": "ok",
                "appName": "Karakeep Transfer",
                "version": "0.1.0"
            }),
        );
    }

    #[test]
    fn version_information_is_available_through_the_desktop_contract() {
        let expected = serde_json::to_value(super::versions::ComponentVersions::current())
            .expect("version information serializes");

        assert_command_response("version_information", expected);
    }

    #[test]
    fn update_check_is_an_explicit_release_page_action() {
        assert_command_response(
            "manual_update_check",
            json!({
                "requestedByUser": true,
                "releasePage": "https://github.com/rupertgermann/karakeep-import/releases/latest",
                "downloadsUpdate": false,
                "executesUpdate": false
            }),
        );
    }

    #[test]
    fn diagnostics_export_only_runs_through_an_explicit_desktop_command() {
        let versions = super::versions::ComponentVersions::current();

        assert_command_response(
            "export_diagnostics",
            json!({
                "generatedByUserAction": true,
                "includesBookmarkContent": false,
                "telemetryEnabled": false,
                "versions": versions,
                "source": "notConfigured",
                "destination": "notConfigured",
                "storage": {
                    "dataDirectory": "private application data",
                    "snapshotBytes": 0,
                    "ledgerBytes": 0
                },
                "lastFailure": null
            }),
        );
    }

    #[test]
    fn diagnostics_export_reflects_live_component_and_storage_state() {
        let directory = tempdir().expect("temporary app state");
        let snapshot = directory.path().join("fieldtheory/bookmarks.jsonl");
        fs::create_dir_all(snapshot.parent().expect("snapshot parent"))
            .expect("snapshot directory");
        fs::write(
            &snapshot,
            "{\"tweetId\":\"private-bookmark-id\",\"url\":\"https://example.invalid/private\"}\n",
        )
        .expect("snapshot");
        let snapshot_bytes = fs::metadata(&snapshot).expect("snapshot metadata").len();
        fs::write(directory.path().join("delivery-ledger.sqlite3"), b"ledger").expect("ledger");
        let app = super::configure_builder(mock_builder())
            .manage(super::FieldTheoryState::bundled(
                directory.path(),
                directory.path(),
            ))
            .manage(super::DestinationState(Arc::new(ConnectedDestination(
                Arc::new(SuccessfulDeliveryApi::default()),
            ))))
            .manage(super::settings::SettingsService::from_app_data_dir(
                directory.path(),
            ))
            .manage(test_transfer_state())
            .build(mock_context(noop_assets()))
            .expect("mock app builds");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview builds");

        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "export_diagnostics".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().expect("valid IPC origin"),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("diagnostics export succeeds")
        .deserialize::<Value>()
        .expect("diagnostics JSON");

        assert_eq!(
            (
                response["source"].as_str(),
                response["destination"].as_str(),
                response["storage"]["dataDirectory"].as_str(),
                response["storage"]["snapshotBytes"].as_u64(),
                response["storage"]["ledgerBytes"].as_u64(),
                response["lastFailure"].as_null(),
                serde_json::to_string(&response)
                    .expect("diagnostics serialize")
                    .contains("private-bookmark-id"),
            ),
            (
                Some("ready"),
                Some("ready"),
                Some("private application data"),
                Some(snapshot_bytes),
                Some(6),
                Some(()),
                false,
            )
        );
    }

    #[test]
    fn rejected_destination_connection_is_retained_as_the_latest_diagnostic_failure() {
        let directory = tempdir().expect("temporary app state");
        let app = super::configure_builder(mock_builder())
            .manage(super::FieldTheoryState::bundled(
                directory.path(),
                directory.path(),
            ))
            .manage(super::DestinationState(Arc::new(DisconnectedDestination)))
            .manage(super::settings::SettingsService::from_app_data_dir(
                directory.path(),
            ))
            .manage(test_transfer_state())
            .build(mock_context(noop_assets()))
            .expect("mock app builds");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview builds");

        let connection = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "connect_destination".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().expect("valid IPC origin"),
                body: json!({
                    "input": {
                        "server": "https://keep.example",
                        "apiKey": "diagnostic-key-canary",
                        "allowInsecureHttp": false
                    }
                })
                .into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        let diagnostics = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "export_diagnostics".into(),
                callback: tauri::ipc::CallbackFn(2),
                error: tauri::ipc::CallbackFn(3),
                url: "tauri://localhost".parse().expect("valid IPC origin"),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("diagnostics export succeeds")
        .deserialize::<Value>()
        .expect("diagnostics JSON");

        assert_eq!(
            (
                connection.is_err(),
                diagnostics["destination"].as_str(),
                diagnostics["lastFailure"]["kind"].as_str(),
                serde_json::to_string(&diagnostics)
                    .expect("diagnostics serialize")
                    .contains("diagnostic-key-canary"),
            ),
            (
                true,
                Some("unavailable"),
                Some("destinationAuthentication"),
                false,
            )
        );
    }

    #[test]
    fn file_preview_requires_the_exact_path_selected_by_the_native_picker() {
        let selected =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/field-theory-one.jsonl");
        let unselected = selected.with_file_name("field-theory-many.jsonl");
        let selections = super::FileSelectionState::default();

        let error = super::preview_selected_file_source(
            &selections,
            &selected,
            super::file_source::FileSourceFormat::FieldTheoryJsonl,
        )
        .expect_err("an arbitrary frontend path is not authorized");
        assert_eq!(error.code, "fileUnreadable");

        selections
            .select(selected.clone())
            .expect("native picker records the selection");
        let preview = super::preview_selected_file_source(
            &selections,
            &selected,
            super::file_source::FileSourceFormat::FieldTheoryJsonl,
        )
        .expect("the exact native selection is previewable");
        assert_eq!(preview.bookmarks.len(), 1);

        let error = super::preview_selected_file_source(
            &selections,
            &unselected,
            super::file_source::FileSourceFormat::FieldTheoryJsonl,
        )
        .expect_err("a different frontend path remains unauthorized");
        assert_eq!(error.code, "fileUnreadable");
    }

    #[test]
    fn file_source_preview_is_available_through_the_desktop_contract() {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/field-theory-one.jsonl");
        let response = command_response(
            "preview_file_source",
            tauri::ipc::InvokeBody::Json(json!({
                "path": path,
                "format": "fieldTheoryJsonl"
            })),
        )
        .expect("preview command succeeds");
        let preview: super::file_source::FileSourcePreview =
            serde_json::from_value(response).expect("typed File Source preview");

        assert_eq!(
            (
                preview.format,
                preview.bookmarks.len(),
                preview.bookmarks[0].source_id.as_str(),
            ),
            (
                super::file_source::ResolvedFileSourceFormat::FieldTheoryJsonl,
                1,
                "123",
            )
        );
    }

    #[test]
    fn private_data_summary_is_available_through_the_desktop_contract() {
        let directory = tempdir().expect("temporary app data");
        fs::create_dir_all(directory.path().join("fieldtheory/acquisition"))
            .expect("acquisition directory");
        fs::write(
            directory.path().join("fieldtheory/bookmarks.jsonl"),
            b"snapshot",
        )
        .expect("snapshot");
        fs::write(
            directory.path().join("fieldtheory/acquisition/cursor"),
            b"state",
        )
        .expect("acquisition state");
        fs::write(directory.path().join("delivery-ledger.sqlite3"), b"ledger").expect("ledger");
        let app = super::configure_builder(mock_builder())
            .manage(super::settings::SettingsService::from_app_data_dir(
                directory.path(),
            ))
            .build(mock_context(noop_assets()))
            .expect("mock app builds");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview builds");

        assert_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "inspect_private_transfer_data".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("valid IPC origin"),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
            Ok::<_, Value>(json!({
                "dataDirectory": directory.path().display().to_string(),
                "snapshotBytes": 8,
                "acquisitionStateBytes": 5,
                "ledgerBytes": 6,
                "totalBytes": 19
            })),
        );
    }

    #[test]
    fn source_replacement_confirmation_runs_through_the_desktop_contract() {
        let directory = tempdir().expect("temporary app data");
        fs::create_dir_all(directory.path().join("fieldtheory/acquisition"))
            .expect("acquisition directory");
        fs::write(
            directory.path().join("fieldtheory/bookmarks.jsonl"),
            b"snapshot",
        )
        .expect("snapshot");
        fs::write(directory.path().join("delivery-ledger.sqlite3"), b"ledger").expect("ledger");

        assert_settings_confirmation_command(
            "replace_x_source",
            "replace-x-source",
            directory.path(),
        );

        assert_eq!(
            (
                directory
                    .path()
                    .join("fieldtheory/bookmarks.jsonl")
                    .exists(),
                directory.path().join("fieldtheory/acquisition").exists(),
                directory.path().join("delivery-ledger.sqlite3").exists(),
            ),
            (false, false, true)
        );
    }

    #[test]
    fn file_source_command_errors_do_not_expose_the_selected_path() {
        let private_path = "/private/selected/bookmarks.jsonl";
        assert_command_response_with_body(
            "preview_file_source",
            tauri::ipc::InvokeBody::Json(json!({
                "path": private_path,
                "format": "fieldTheoryJsonl"
            })),
            Err(json!({
                "code": "fileUnreadable",
                "message": "The selected file could not be read."
            })),
        );
    }

    #[test]
    fn invalid_file_source_details_are_redacted_at_the_desktop_boundary() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let path = temporary.path().join("private-bookmarks.jsonl");
        std::fs::write(
            &path,
            "{\"id\":\"bookmark-content-canary\",\"url\":\"not-a-web-url\"}\n",
        )
        .expect("invalid fixture");
        assert_command_response_with_body(
            "preview_file_source",
            tauri::ipc::InvokeBody::Json(json!({
                "path": path,
                "format": "fieldTheoryJsonl"
            })),
            Err(json!({
                "code": "invalidFileSource",
                "message": "The selected file is not a valid supported File Source."
            })),
        );
    }

    #[test]
    fn transfer_preview_requires_the_connected_backend_destination() {
        assert_command_response_with_body(
            "preview_transfer",
            tauri::ipc::InvokeBody::Json(json!({
                "source": {
                    "kind": "file",
                    "path": "/private/selected/bookmarks.jsonl",
                    "format": "fieldTheoryJsonl"
                }
            })),
            Err(json!({
                "code": "destination-authentication",
                "message": "Reconnect Karakeep before continuing."
            })),
        );
    }

    #[test]
    fn transfer_preview_rejects_an_existing_file_that_was_not_selected_natively() {
        let directory = tempdir().expect("temporary app state");
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/field-theory-one.jsonl");
        let api = Arc::new(SuccessfulDeliveryApi::default());
        let app = super::configure_builder(mock_builder())
            .manage(super::FieldTheoryState::bundled(
                directory.path(),
                directory.path(),
            ))
            .manage(super::DestinationState(Arc::new(ConnectedDestination(api))))
            .manage(test_transfer_state())
            .build(mock_context(noop_assets()))
            .expect("mock app builds");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview builds");

        assert_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "preview_transfer".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("valid IPC origin"),
                body: tauri::ipc::InvokeBody::Json(json!({
                    "source": {
                        "kind": "file",
                        "path": source,
                        "format": "fieldTheoryJsonl"
                    }
                })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
            Err(json!({
                "code": "source-unavailable",
                "message": "The selected bookmark source is unavailable."
            })),
        );
    }

    #[test]
    fn invalid_delivery_identifiers_are_redacted_before_startup() {
        assert_command_response_with_body(
            "start_delivery",
            tauri::ipc::InvokeBody::Json(json!({
                "request": {
                    "deliveryId": "../private-delivery",
                    "source": { "kind": "x" }
                }
            })),
            Err(json!({
                "code": "unexpected",
                "message": "The transfer operation could not be completed."
            })),
        );
    }

    #[test]
    fn local_data_deletion_releases_the_persistent_ledger_handle() {
        let directory = tempdir().expect("temporary app state");
        let ledger_path = directory.path().join("delivery-ledger.sqlite3");
        let transfers = super::TransferState::new(ledger_path.clone());
        let coordinator = transfers.coordinator().expect("coordinator opens");
        let weak = Arc::downgrade(&coordinator);
        drop(coordinator);

        transfers.close_ledger().expect("ledger closes");

        assert!(weak.upgrade().is_none());
        fs::remove_file(ledger_path).expect("closed ledger can be deleted");
    }

    #[test]
    fn reviewed_file_approval_is_bound_to_the_reviewed_destination() {
        let transfers = test_transfer_state();
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/field-theory-one.jsonl");
        let source = super::TransferSourceRequest::File {
            path: path.clone(),
            format: super::file_source::FileSourceFormat::FieldTheoryJsonl,
        };
        let preview = super::file_source::preview_file(
            &path,
            super::file_source::FileSourceFormat::FieldTheoryJsonl,
        )
        .expect("reviewed file preview");
        let reviewed_destination =
            super::DestinationIdentity::new("https://keep.example", "user-a")
                .expect("reviewed destination");
        let other_destination = super::DestinationIdentity::new("https://other.example", "user-b")
            .expect("different destination");
        let approval = transfers
            .approve_file_source(&source, &preview, &reviewed_destination)
            .expect("file approval")
            .expect("opaque approval ID");

        let error = transfers
            .approved_file_preview(Some(&approval), &source, &other_destination)
            .expect_err("approval cannot be reused for another destination");

        assert_eq!(
            error.code,
            super::TransferCommandErrorCode::SourceUnavailable
        );
    }

    #[test]
    fn file_preview_returns_an_opaque_approval_and_safe_summary() {
        let harness = FileDeliveryHarness::new();
        let serialized = harness.reviewed_preview.to_string();
        let mut summary = harness.reviewed_preview.clone();
        summary
            .as_object_mut()
            .expect("preview object")
            .remove("approvalId");

        assert_eq!(
            (
                harness.approval_id.is_empty(),
                serialized.contains("selected-bookmarks"),
                serialized.contains(&harness.source.display().to_string()),
                serialized.contains("A useful post"),
                summary,
            ),
            (
                false,
                false,
                false,
                false,
                json!({
                    "total": 1,
                    "pending": 1,
                    "previouslyDelivered": 0,
                    "folders": ["Reading"],
                    "destination": {
                        "serverUrl": "https://keep.example",
                        "userId": "user-1",
                        "userName": "Test Reader"
                    }
                }),
            )
        );
    }

    #[test]
    fn clearing_local_transfer_state_invalidates_the_reviewed_file_approval() {
        let transfers = test_transfer_state();
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/field-theory-one.jsonl");
        let source = super::TransferSourceRequest::File {
            path: path.clone(),
            format: super::file_source::FileSourceFormat::FieldTheoryJsonl,
        };
        let preview = super::file_source::preview_file(
            &path,
            super::file_source::FileSourceFormat::FieldTheoryJsonl,
        )
        .expect("reviewed file preview");
        let destination = super::DestinationIdentity::new("https://keep.example", "user-a")
            .expect("reviewed destination");
        let approval = transfers
            .approve_file_source(&source, &preview, &destination)
            .expect("file approval")
            .expect("opaque approval ID");

        transfers
            .clear_file_approval()
            .expect("ephemeral file approval clears");

        let error = transfers
            .approved_file_preview(Some(&approval), &source, &destination)
            .expect_err("deleted local state cannot reuse the old approval");
        assert_eq!(
            error.code,
            super::TransferCommandErrorCode::SourceUnavailable
        );
    }

    #[test]
    fn file_delivery_uses_the_reviewed_snapshot_when_the_file_changes() {
        let harness = FileDeliveryHarness::new();
        harness.change_source_after_review();

        assert_eq!(
            harness.start("delivery-reviewed", &harness.approval_id),
            Ok(Value::Null)
        );
        let terminal = harness.wait_for_terminal("delivery-reviewed");
        let notes = harness.api.notes.lock().expect("captured notes");
        let delivered_note = notes[0].as_deref().expect("delivered note");

        assert_eq!(
            (
                terminal["type"].as_str(),
                delivered_note.contains("A useful post"),
                delivered_note.contains("Changed after review"),
            ),
            (Some("completed"), true, false)
        );
    }

    #[test]
    fn reviewed_file_approval_remains_available_for_a_safe_retry() {
        let harness = FileDeliveryHarness::new();
        assert_eq!(
            harness.start("delivery-first", &harness.approval_id),
            Ok(Value::Null)
        );
        harness.wait_for_terminal("delivery-first");
        harness.wait_for_operation_release();

        assert_eq!(
            harness.start("delivery-retry", &harness.approval_id),
            Ok(Value::Null)
        );
        let retry = harness.wait_for_terminal("delivery-retry");

        assert_eq!(
            (
                retry["type"].as_str(),
                retry["deliveryId"].as_str(),
                harness.api.creates.load(Ordering::SeqCst),
            ),
            (Some("completed"), Some("delivery-retry"), 1)
        );
    }

    #[test]
    fn a_new_file_preview_makes_the_previous_approval_stale() {
        let harness = FileDeliveryHarness::new();
        let stale_approval = harness.approval_id.clone();
        let next_preview = harness.preview_again().expect("next preview");
        let next_approval = next_preview["approvalId"]
            .as_str()
            .expect("next approval ID");
        assert_ne!(next_approval, stale_approval);

        assert_eq!(
            harness.start("delivery-stale-approval", &stale_approval),
            Err(json!({
                "code": "source-unavailable",
                "message": "The selected bookmark source is unavailable."
            }))
        );
    }

    #[test]
    fn file_preview_counts_reflect_the_completed_delivery() {
        let harness = FileDeliveryHarness::new();
        assert_eq!(
            harness.start("delivery-counts", &harness.approval_id),
            Ok(Value::Null)
        );
        harness.wait_for_terminal("delivery-counts");
        harness.wait_for_operation_release();

        let after = harness.preview_again().expect("preview after delivery");

        assert_eq!(
            (
                after["pending"].as_u64(),
                after["previouslyDelivered"].as_u64(),
            ),
            (Some(0), Some(1))
        );
    }

    #[test]
    fn local_deletion_confirmation_runs_through_the_desktop_contract() {
        let directory = tempdir().expect("temporary app data");
        fs::create_dir_all(directory.path().join("fieldtheory/acquisition"))
            .expect("acquisition directory");
        fs::write(
            directory.path().join("fieldtheory/bookmarks.jsonl"),
            b"snapshot",
        )
        .expect("snapshot");
        fs::write(
            directory
                .path()
                .join("fieldtheory/acquisition/bookmarks-backfill-state.json"),
            b"state",
        )
        .expect("backfill state");
        fs::write(
            directory
                .path()
                .join("fieldtheory/acquisition/bookmarks-meta.json"),
            b"metadata",
        )
        .expect("metadata");
        fs::write(directory.path().join("delivery-ledger.sqlite3"), b"ledger").expect("ledger");

        assert_settings_confirmation_command(
            "delete_local_transfer_data",
            "delete-local-transfer-data",
            directory.path(),
        );

        assert_eq!(
            (
                directory
                    .path()
                    .join("fieldtheory/bookmarks.jsonl")
                    .exists(),
                directory.path().join("fieldtheory/acquisition").exists(),
                directory.path().join("delivery-ledger.sqlite3").exists(),
            ),
            (false, false, false)
        );
    }

    #[test]
    fn x_acquisition_requires_the_exact_source_selected_in_this_session() {
        let selections = super::XSelectionState::default();
        let selected = super::XSourceReference {
            browser_id: "chrome".to_string(),
            profile_id: "Profile 1".to_string(),
        };
        let other_profile = super::XSourceReference {
            browser_id: "chrome".to_string(),
            profile_id: "Profile 2".to_string(),
        };

        assert!(selections.authorize(&selected).is_err());
        selections
            .select(selected.clone())
            .expect("selection stores");
        assert!(selections.authorize(&selected).is_ok());
        assert!(selections.authorize(&other_profile).is_err());
        selections.clear().expect("selection clears");
        assert!(selections.authorize(&selected).is_err());
    }
}
