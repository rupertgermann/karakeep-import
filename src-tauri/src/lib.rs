use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

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
    DeliveryCoordinator, DeliveryCoordinatorErrorCode, DeliveryEvent, DeliveryEventSink, DeliveryId,
};
use destination::{
    ConnectDestinationInput, DestinationError, DestinationErrorCode, DestinationService,
    DestinationSummary, FileDestinationSettings, NativeCredentialVault, ReqwestKarakeepClient,
};
use domain::DestinationIdentity;

use fieldtheory::{
    AcquisitionEvent, BridgeCommand, BridgeRequest, DestinationPreview, DiscoveryResponse,
    FieldTheoryState, SelectedXSource, XAcquisitionRequest, XSourceSelection, XTransferPreview,
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
) -> Result<diagnostics::DiagnosticsExport, &'static str> {
    state.explicit_export()
}

#[tauri::command]
async fn save_diagnostics<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, diagnostics::DiagnosticsStore>,
) -> Result<bool, &'static str> {
    let export = state.explicit_export()?;
    let dialog = diagnostics_save::NativeDiagnosticsSaveDialog::new(app);

    tauri::async_runtime::spawn_blocking(move || {
        diagnostics_save::save_diagnostics_export(&dialog, &export)
    })
    .await
    .map_err(|_| "diagnostics could not be saved")?
    .map_err(diagnostics_save::DiagnosticsSaveError::public_message)
}

#[tauri::command]
fn discover_x_sources(
    state: tauri::State<'_, FieldTheoryState>,
) -> Result<DiscoveryResponse, String> {
    state
        .runner()
        .request(&BridgeRequest::new(
            "discover-x-sources",
            BridgeCommand::DiscoverSources,
        ))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn select_x_source(
    state: tauri::State<'_, FieldTheoryState>,
    request: XSourceSelection,
) -> Result<SelectedXSource, String> {
    state
        .runner()
        .request(&BridgeRequest::select("select-x-source", request))
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSourceCommandError {
    code: &'static str,
    message: &'static str,
}

#[tauri::command]
fn preview_file_source(
    path: PathBuf,
    format: file_source::FileSourceFormat,
) -> Result<file_source::FileSourcePreview, FileSourceCommandError> {
    if !path.is_file() {
        return Err(FileSourceCommandError {
            code: "fileUnreadable",
            message: "The selected file could not be read.",
        });
    }

    file_source::preview_file(&path, format).map_err(|_| FileSourceCommandError {
        code: "invalidFileSource",
        message: "The selected file is not a valid supported File Source.",
    })
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
) -> Result<Option<DestinationSummary>, DestinationError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || service.status())
        .await
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))?
}

#[tauri::command]
async fn connect_destination(
    input: ConnectDestinationInput,
    state: tauri::State<'_, DestinationState>,
) -> Result<DestinationSummary, DestinationError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || service.connect(input))
        .await
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::Network))?
}

#[tauri::command]
async fn forget_destination(
    state: tauri::State<'_, DestinationState>,
    transfers: tauri::State<'_, TransferState>,
) -> Result<(), DestinationError> {
    let operation = transfers
        .operations
        .reserve(OperationKind::Maintenance)
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))?;
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        service.forget()
    })
        .await
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))?
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
    transfers: tauri::State<'_, TransferState>,
    confirmation: settings::ReplaceXSourceConfirmation,
) -> Result<(), &'static str> {
    let _operation = transfers
        .operations
        .reserve(OperationKind::Maintenance)
        .map_err(|_| "local transfer data is in use")?;
    state
        .replace_x_source(confirmation.capability())
        .map_err(|_| "X source data could not be replaced")
}

#[tauri::command]
fn delete_local_transfer_data(
    state: tauri::State<'_, settings::SettingsService>,
    transfers: tauri::State<'_, TransferState>,
    confirmation: settings::DeleteLocalTransferDataConfirmation,
) -> Result<(), &'static str> {
    let _operation = transfers
        .operations
        .reserve(OperationKind::Maintenance)
        .map_err(|_| "local transfer data is in use")?;
    transfers.close_ledger()?;
    state
        .delete_local_transfer_data(confirmation.capability())
        .map_err(|_| "local transfer data could not be deleted")
}

#[tauri::command]
fn start_x_acquisition<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, FieldTheoryState>,
    transfers: tauri::State<'_, TransferState>,
    request: XAcquisitionRequest,
) -> Result<(), String> {
    let operation = transfers
        .operations
        .reserve(OperationKind::Acquisition)
        .map_err(|_| "another transfer operation is already active".to_owned())?;
    let operation = Arc::new(Mutex::new(Some(operation)));
    let terminal_operation = Arc::clone(&operation);
    state
        .start_acquisition(request, move |event| {
            let terminal = matches!(
                event,
                AcquisitionEvent::Completed { .. }
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
    coordinator: Mutex<Option<Arc<DeliveryCoordinator>>>,
    ledger_path: PathBuf,
    operations: OperationGate,
}

impl TransferState {
    fn new(ledger_path: PathBuf) -> Self {
        Self {
            coordinator: Mutex::new(None),
            ledger_path,
            operations: OperationGate::default(),
        }
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        let ledger = ledger::DeliveryLedger::open_in_memory().expect("in-memory delivery ledger");
        Self {
            coordinator: Mutex::new(Some(Arc::new(DeliveryCoordinator::new(Arc::new(
                Mutex::new(ledger),
            ))))),
            ledger_path: PathBuf::new(),
            operations: OperationGate::default(),
        }
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartDeliveryRequest {
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
    field_theory: tauri::State<'_, FieldTheoryState>,
    destination: tauri::State<'_, DestinationState>,
    transfers: tauri::State<'_, TransferState>,
) -> Result<TransferPreview, TransferCommandError> {
    let (destination_summary, destination_identity) =
        connected_destination(destination.0.as_ref())?;
    let preview =
        resolve_transfer_source(&source, &field_theory).map_err(map_transfer_source_error)?;
    let counts = transfers
        .coordinator()?
        .preview(&preview, &destination_identity)
        .map_err(map_coordinator_error)?;
    Ok(TransferPreview {
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
    let preview = resolve_transfer_source(&request.source, &field_theory)
        .map_err(map_transfer_source_error)?;
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
            Arc,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::Duration,
    };

    use serde_json::{Value, json};
    use tauri::{
        Listener, WebviewWindowBuilder,
        test::{
            INVOKE_KEY, assert_ipc_response, get_ipc_response, mock_builder, mock_context,
            noop_assets,
        },
        webview::InvokeRequest,
    };
    use tempfile::tempdir;

    struct DisconnectedDestination;

    #[derive(Default)]
    struct SuccessfulDeliveryApi {
        creates: AtomicUsize,
    }

    impl super::karakeep::KarakeepApi for SuccessfulDeliveryApi {
        fn ensure_bookmark(
            &self,
            _draft: &super::karakeep::BookmarkDraft,
            _cancellation: &dyn super::karakeep::RequestCancellation,
        ) -> Result<super::karakeep::EnsuredBookmark, super::karakeep::ApiError> {
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
            .manage(test_transfer_state())
            .build(mock_context(noop_assets()))
            .expect("mock app builds");
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
                    "dataDirectory": "not available",
                    "snapshotBytes": 0,
                    "ledgerBytes": 0
                },
                "lastFailure": null
            }),
        );
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
        fs::create_dir_all(directory.path().join("field-theory/acquisition"))
            .expect("acquisition directory");
        fs::write(
            directory.path().join("field-theory/bookmarks.jsonl"),
            b"snapshot",
        )
        .expect("snapshot");
        fs::write(
            directory.path().join("field-theory/acquisition/cursor"),
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
        fs::create_dir_all(directory.path().join("field-theory/acquisition"))
            .expect("acquisition directory");
        fs::write(
            directory.path().join("field-theory/bookmarks.jsonl"),
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
                    .join("field-theory/bookmarks.jsonl")
                    .exists(),
                directory.path().join("field-theory/acquisition").exists(),
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
    fn file_transfer_runs_through_the_tauri_boundary_and_updates_preview() {
        let directory = tempdir().expect("temporary app state");
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/field-theory-one.jsonl");
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
        let preview = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "preview_transfer".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().expect("valid IPC origin"),
                body: request_body.clone().into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("preview succeeds")
        .deserialize::<Value>()
        .expect("preview JSON");
        assert_eq!(
            preview,
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
            })
        );

        assert_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "start_delivery".into(),
                callback: tauri::ipc::CallbackFn(2),
                error: tauri::ipc::CallbackFn(3),
                url: "tauri://localhost".parse().expect("valid IPC origin"),
                body: json!({
                    "request": {
                        "deliveryId": "delivery-ipc",
                        "source": request_body["source"].clone()
                    }
                })
                .into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
            Ok::<_, Value>(Value::Null),
        );

        let terminal = (0..2)
            .find_map(|_| {
                let payload = delivered
                    .recv_timeout(Duration::from_secs(2))
                    .expect("delivery event");
                let value: Value = serde_json::from_str(&payload).expect("event JSON");
                (value["type"] == "completed").then_some(value)
            })
            .expect("completed event");
        assert_eq!(
            terminal,
            json!({
                "type": "completed",
                "deliveryId": "delivery-ipc",
                "result": {
                    "created": 1,
                    "existing": 0,
                    "retried": 0,
                    "failed": 0,
                    "cancelled": 0
                }
            })
        );
        assert_eq!(api.creates.load(Ordering::SeqCst), 1);

        let after = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "preview_transfer".into(),
                callback: tauri::ipc::CallbackFn(4),
                error: tauri::ipc::CallbackFn(5),
                url: "tauri://localhost".parse().expect("valid IPC origin"),
                body: request_body.into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("preview after delivery succeeds")
        .deserialize::<Value>()
        .expect("preview JSON");
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
        fs::create_dir_all(directory.path().join("field-theory/acquisition"))
            .expect("acquisition directory");
        fs::write(
            directory.path().join("field-theory/bookmarks.jsonl"),
            b"snapshot",
        )
        .expect("snapshot");
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
                    .join("field-theory/bookmarks.jsonl")
                    .exists(),
                directory.path().join("field-theory/acquisition").exists(),
                directory.path().join("delivery-ledger.sqlite3").exists(),
            ),
            (false, false, false)
        );
    }
}
