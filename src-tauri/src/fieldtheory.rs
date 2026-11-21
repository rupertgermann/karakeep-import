use std::{
    fmt,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    domain::DestinationIdentity, file_source::FileSourcePreview, ledger::DeliveryLedger,
    transfer_options::TransferOptions,
};

#[path = "fieldtheory_acquisition.rs"]
mod acquisition;

pub use acquisition::*;

const PROTOCOL_VERSION: u8 = 1;
const GENERIC_FAILURE: &str = "The Field Theory bridge could not complete the request.";
pub const X_SOURCE_DATA_DIRECTORY: &str = "fieldtheory";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    protocol_version: u8,
    request_id: String,
    command: BridgeCommand,
    #[serde(skip_serializing_if = "Option::is_none")]
    consent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<XSourceReference>,
}

impl BridgeRequest {
    pub fn new(request_id: impl Into<String>, command: BridgeCommand) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            command,
            consent: None,
            source: None,
        }
    }

    pub fn select(request_id: impl Into<String>, selection: XSourceSelection) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            command: BridgeCommand::SelectSource,
            consent: Some(selection.consent),
            source: Some(selection.source),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum BridgeCommand {
    DiscoverSources,
    SelectSource,
}

impl Serialize for BridgeCommand {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(match self {
            Self::DiscoverSources => "discoverSources",
            Self::SelectSource => "selectSource",
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSource {
    pub id: String,
    pub name: String,
    pub profiles: Vec<BrowserProfile>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResponse {
    pub browsers: Vec<BrowserSource>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XSourceReference {
    pub browser_id: String,
    pub profile_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XSourceSelection {
    pub consent: bool,
    pub source: XSourceReference,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectedXSource {
    pub browser_id: String,
    pub browser_name: String,
    pub profile_id: String,
    pub profile_name: String,
}

#[derive(Debug)]
pub struct BridgeError(&'static str);

impl fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for BridgeError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireResponse<T> {
    protocol_version: u8,
    request_id: String,
    #[serde(rename = "type")]
    response_type: String,
    data: Option<T>,
    error: Option<WireError>,
}

#[derive(Debug, Deserialize)]
struct WireError {
    code: String,
}

pub struct BridgeRunner {
    node_path: PathBuf,
    bridge_path: PathBuf,
}

pub struct FieldTheoryState {
    runner: BridgeRunner,
    acquisitions: AcquisitionSupervisor,
    snapshots: SnapshotStore,
    ledger_path: PathBuf,
}

impl FieldTheoryState {
    pub fn bundled(resource_dir: &Path, app_data_dir: &Path) -> Self {
        Self {
            runner: BridgeRunner::bundled(resource_dir),
            acquisitions: AcquisitionSupervisor::default(),
            snapshots: SnapshotStore::new(app_data_dir.join(X_SOURCE_DATA_DIRECTORY)),
            ledger_path: app_data_dir.join("delivery-ledger.sqlite3"),
        }
    }

    pub fn runner(&self) -> &BridgeRunner {
        &self.runner
    }

    pub fn start_acquisition<F>(
        &self,
        request: XAcquisitionRequest,
        emit: F,
    ) -> Result<(), AcquisitionStartError>
    where
        F: Fn(AcquisitionEvent) + Send + Sync + 'static,
    {
        self.acquisitions
            .start(&self.runner, request, self.snapshots.clone(), emit)
    }

    pub fn cancel_acquisition(&self, acquisition_id: &str) -> Result<(), AcquisitionStartError> {
        self.acquisitions.cancel(acquisition_id)
    }

    /// Returns parsed retained X bookmarks for backend delivery without
    /// exposing their private storage path.
    pub fn snapshot_delivery_source(
        &self,
        options: &TransferOptions,
    ) -> Result<FileSourcePreview, SnapshotPreviewError> {
        self.snapshots.delivery_source(options)
    }

    pub fn has_snapshot(&self) -> bool {
        self.snapshots.has_snapshot()
    }

    pub fn snapshot_bytes(&self) -> std::io::Result<u64> {
        self.snapshots.snapshot_bytes()
    }

    pub fn preview(
        &self,
        destination: DestinationPreview,
        options: &TransferOptions,
    ) -> Result<XTransferPreview, SnapshotPreviewError> {
        let identity = DestinationIdentity::new(&destination.server_url, &destination.user_id)
            .map_err(|_| SnapshotPreviewError)?;
        let ledger = DeliveryLedger::open(&self.ledger_path).map_err(|_| SnapshotPreviewError)?;
        self.snapshots
            .preview(&ledger, &identity, destination, options)
    }
}

impl BridgeRunner {
    pub fn new(node_path: PathBuf, bridge_path: PathBuf) -> Self {
        Self {
            node_path,
            bridge_path,
        }
    }

    pub fn bundled(resource_dir: &Path) -> Self {
        let platform_dir = if cfg!(target_os = "windows") {
            "win-x64"
        } else if cfg!(target_arch = "aarch64") {
            "darwin-arm64"
        } else {
            "darwin-x64"
        };
        let executable = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        Self::new(
            resource_dir
                .join("node")
                .join(platform_dir)
                .join(executable),
            resource_dir
                .join("fieldtheory")
                .join("bridge")
                .join("src")
                .join("index.mjs"),
        )
    }

    pub fn request<T: DeserializeOwned>(&self, request: &BridgeRequest) -> Result<T, BridgeError> {
        let mut command = Command::new(&self.node_path);
        command.arg(&self.bridge_path).env_clear();
        acquisition::copy_required_process_environment(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| BridgeError(GENERIC_FAILURE))?;

        let stdin = child.stdin.as_mut().ok_or(BridgeError(GENERIC_FAILURE))?;
        serde_json::to_writer(&mut *stdin, request).map_err(|_| BridgeError(GENERIC_FAILURE))?;
        stdin
            .write_all(b"\n")
            .map_err(|_| BridgeError(GENERIC_FAILURE))?;
        drop(child.stdin.take());

        let output = child
            .wait_with_output()
            .map_err(|_| BridgeError(GENERIC_FAILURE))?;
        if !output.status.success() || output.stdout.len() > 1_048_576 {
            return Err(BridgeError(GENERIC_FAILURE));
        }
        let stdout =
            std::str::from_utf8(&output.stdout).map_err(|_| BridgeError(GENERIC_FAILURE))?;
        let mut lines = stdout.lines().filter(|line| !line.trim().is_empty());
        let line = lines.next().ok_or(BridgeError(GENERIC_FAILURE))?;
        if lines.next().is_some() {
            return Err(BridgeError(GENERIC_FAILURE));
        }
        let response: WireResponse<T> =
            serde_json::from_str(line).map_err(|_| BridgeError(GENERIC_FAILURE))?;
        if response.protocol_version != PROTOCOL_VERSION
            || response.request_id != request.request_id
        {
            return Err(BridgeError(GENERIC_FAILURE));
        }
        if response.response_type == "result" {
            return response.data.ok_or(BridgeError(GENERIC_FAILURE));
        }
        let message = match response.error.map(|error| error.code).as_deref() {
            Some("consent_required") => "Explicit X-session consent is required.",
            Some("source_unavailable") => "The selected browser profile is no longer available.",
            _ => GENERIC_FAILURE,
        };
        Err(BridgeError(message))
    }
}
