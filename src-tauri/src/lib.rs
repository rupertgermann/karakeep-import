use std::{path::PathBuf, sync::Arc};

use serde::Serialize;
use tauri::Manager;

pub mod bookmark;
pub mod delivery;
pub mod destination;
pub mod diagnostics;
pub mod domain;
pub mod fieldtheory;
pub mod file_source;
pub mod karakeep;
pub mod ledger;
pub mod private_data;
pub mod redaction;
pub mod updates;
pub mod versions;

use destination::{
    ConnectDestinationInput, DestinationError, DestinationErrorCode, DestinationService,
    DestinationSummary, FileDestinationSettings, NativeCredentialVault, ReqwestKarakeepClient,
};

use fieldtheory::{
    BridgeCommand, BridgeRequest, DiscoveryResponse, FieldTheoryState, SelectedXSource,
    XSourceSelection,
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

struct DestinationState(Arc<NativeDestinationService>);

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
) -> Result<(), DestinationError> {
    let service = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || service.forget())
        .await
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))?
}

fn configure_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(diagnostics::DiagnosticsStore::default())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            app.manage(FieldTheoryState::bundled(&resource_dir));
            let settings_path = app.path().app_config_dir()?.join("destination.json");
            let service = DestinationService::new(
                ReqwestKarakeepClient::new(),
                NativeCredentialVault::new()?,
                FileDestinationSettings::new(settings_path),
            );
            app.manage(DestinationState(Arc::new(service)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            version_information,
            manual_update_check,
            export_diagnostics,
            discover_x_sources,
            select_x_source,
            preview_file_source,
            destination_status,
            connect_destination,
            forget_destination
        ])
}

pub fn run() {
    configure_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Karakeep Transfer");
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::{Value, json};
    use tauri::{
        WebviewWindowBuilder,
        test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets},
        webview::InvokeRequest,
    };

    fn command_response(command: &str, body: tauri::ipc::InvokeBody) -> Result<Value, Value> {
        let app = super::configure_builder(mock_builder())
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
}
