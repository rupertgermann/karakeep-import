use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{BridgeRunner, PROTOCOL_VERSION, XSourceReference};
use crate::{
    domain::{BookmarkKey, DestinationIdentity},
    file_source::{FileSourceFormat, FileSourcePreview, preview_file},
    ledger::DeliveryLedger,
    transfer::FIELD_THEORY_LEDGER_SOURCE,
};

const SNAPSHOT_FILE: &str = "bookmarks.jsonl";
const ACQUISITION_STATE_DIRECTORY: &str = "acquisition";
const SOURCE_BINDING_FILE: &str = "source.json";
const COMPATIBILITY_MESSAGE: &str = "X bookmark acquisition is temporarily incompatible. A Karakeep Transfer update may be required.";
const GENERIC_ACQUISITION_MESSAGE: &str = "X bookmark acquisition could not be completed.";
const MAX_WIRE_LINE_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XAcquisitionRequest {
    pub acquisition_id: String,
    pub source: XSourceReference,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AcquisitionPhase {
    Bookmarks,
    Folders,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AcquisitionFailureCode {
    XCompatibility,
    SourceUnavailable,
    Unexpected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcquisitionEvent {
    Progress {
        #[serde(rename = "acquisitionId")]
        acquisition_id: String,
        phase: AcquisitionPhase,
        completed: u64,
        total: Option<u64>,
    },
    Completed {
        #[serde(rename = "acquisitionId")]
        acquisition_id: String,
        total: u64,
        added: u64,
        folders: Vec<String>,
    },
    Cancelled {
        #[serde(rename = "acquisitionId")]
        acquisition_id: String,
    },
    Failed {
        #[serde(rename = "acquisitionId")]
        acquisition_id: String,
        code: AcquisitionFailureCode,
        message: String,
        #[serde(rename = "previousSnapshotAvailable")]
        previous_snapshot_available: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationPreview {
    pub server_url: String,
    pub user_id: String,
    pub user_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XTransferPreview {
    pub total: u64,
    pub pending: u64,
    pub previously_delivered: u64,
    pub folders: Vec<String>,
    pub destination: DestinationPreview,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcquisitionStartError {
    InvalidAcquisitionId,
    OperationActive,
    OperationNotActive,
    BridgeUnavailable,
    PrivateStorageUnavailable,
}

impl std::fmt::Display for AcquisitionStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAcquisitionId => "acquisition identifier is invalid",
            Self::OperationActive => "another acquisition is already running",
            Self::OperationNotActive => "the requested acquisition is not running",
            Self::BridgeUnavailable => "the Field Theory bridge is unavailable",
            Self::PrivateStorageUnavailable => "private snapshot storage is unavailable",
        })
    }
}

impl std::error::Error for AcquisitionStartError {}

#[derive(Debug)]
pub struct SnapshotPreviewError;

impl std::fmt::Display for SnapshotPreviewError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the private X Bookmark Snapshot could not be previewed")
    }
}

impl std::error::Error for SnapshotPreviewError {}

#[derive(Clone)]
pub struct SnapshotStore {
    root: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotBinding {
    source_fingerprint: String,
}

impl SnapshotStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn snapshot_path(&self) -> PathBuf {
        self.root.join(SNAPSHOT_FILE)
    }

    pub fn has_snapshot(&self) -> bool {
        self.snapshot_path().is_file()
    }

    pub fn snapshot_bytes(&self) -> std::io::Result<u64> {
        match fs::metadata(self.snapshot_path()) {
            Ok(metadata) => Ok(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error),
        }
    }

    fn source_binding_path(&self) -> PathBuf {
        self.root
            .join(ACQUISITION_STATE_DIRECTORY)
            .join(SOURCE_BINDING_FILE)
    }

    fn has_snapshot_for(&self, source: &XSourceReference) -> bool {
        if !self.has_snapshot() {
            return false;
        }
        fs::read(self.source_binding_path())
            .ok()
            .and_then(|binding| serde_json::from_slice::<SnapshotBinding>(&binding).ok())
            .is_some_and(|binding| binding.source_fingerprint == source_fingerprint(source))
    }

    /// Returns the retained X snapshot through the same parsed delivery seam
    /// used by one-off File Sources. The private storage path stays internal.
    pub fn delivery_source(&self) -> Result<FileSourcePreview, SnapshotPreviewError> {
        preview_file(&self.snapshot_path(), FileSourceFormat::FieldTheoryJsonl)
            .map_err(|_| SnapshotPreviewError)
    }

    pub fn preview(
        &self,
        ledger: &DeliveryLedger,
        destination_identity: &DestinationIdentity,
        destination: DestinationPreview,
    ) -> Result<XTransferPreview, SnapshotPreviewError> {
        let source = self.delivery_source()?;
        let mut previously_delivered = 0_u64;
        let mut folder_keys = HashSet::new();
        let mut folders = Vec::new();

        for bookmark in &source.bookmarks {
            let key = BookmarkKey::new(FIELD_THEORY_LEDGER_SOURCE, &bookmark.source_id)
                .map_err(|_| SnapshotPreviewError)?;
            if ledger
                .delivery_for(destination_identity, &key)
                .map_err(|_| SnapshotPreviewError)?
                .is_some()
            {
                previously_delivered += 1;
            }
            for folder in &bookmark.folders {
                if folder_keys.insert(folder.to_lowercase()) {
                    folders.push(folder.clone());
                }
            }
        }

        let total = u64::try_from(source.bookmarks.len()).map_err(|_| SnapshotPreviewError)?;
        Ok(XTransferPreview {
            total,
            pending: total.saturating_sub(previously_delivered),
            previously_delivered,
            folders,
            destination,
        })
    }

    fn prepare(
        &self,
        acquisition_id: &str,
        source: &XSourceReference,
    ) -> Result<PathBuf, AcquisitionStartError> {
        fs::create_dir_all(&self.root)
            .map_err(|_| AcquisitionStartError::PrivateStorageUnavailable)?;
        set_private_directory_permissions(&self.root)
            .map_err(|_| AcquisitionStartError::PrivateStorageUnavailable)?;
        let staging = self.root.join(format!(".acquisition-{acquisition_id}"));
        if staging.exists() {
            fs::remove_dir_all(&staging)
                .map_err(|_| AcquisitionStartError::PrivateStorageUnavailable)?;
        }
        fs::create_dir(&staging).map_err(|_| AcquisitionStartError::PrivateStorageUnavailable)?;
        set_private_directory_permissions(&staging)
            .map_err(|_| AcquisitionStartError::PrivateStorageUnavailable)?;
        if self.has_snapshot_for(source) {
            fs::copy(self.snapshot_path(), staging.join(SNAPSHOT_FILE))
                .map_err(|_| AcquisitionStartError::PrivateStorageUnavailable)?;
        }
        Ok(staging)
    }

    fn promote(
        &self,
        staging: &Path,
        source: &XSourceReference,
    ) -> Result<(), SnapshotPreviewError> {
        let incoming = staging.join(SNAPSHOT_FILE);
        let metadata = fs::symlink_metadata(&incoming).map_err(|_| SnapshotPreviewError)?;
        if !metadata.file_type().is_file() {
            return Err(SnapshotPreviewError);
        }
        preview_file(&incoming, FileSourceFormat::FieldTheoryJsonl)
            .map_err(|_| SnapshotPreviewError)?;
        set_private_file_permissions(&incoming).map_err(|_| SnapshotPreviewError)?;

        let state_directory = self.root.join(ACQUISITION_STATE_DIRECTORY);
        fs::create_dir_all(&state_directory).map_err(|_| SnapshotPreviewError)?;
        set_private_directory_permissions(&state_directory).map_err(|_| SnapshotPreviewError)?;
        let incoming_binding = staging.join(SOURCE_BINDING_FILE);
        fs::write(
            &incoming_binding,
            serde_json::to_vec(&SnapshotBinding {
                source_fingerprint: source_fingerprint(source),
            })
            .map_err(|_| SnapshotPreviewError)?,
        )
        .map_err(|_| SnapshotPreviewError)?;
        set_private_file_permissions(&incoming_binding).map_err(|_| SnapshotPreviewError)?;

        let snapshot = self.snapshot_path();
        let source_binding = self.source_binding_path();
        let snapshot_backup = state_directory.join("bookmarks.previous.jsonl");
        let source_binding_backup = state_directory.join("source.previous.json");
        for backup in [&snapshot_backup, &source_binding_backup] {
            if backup.exists() {
                fs::remove_file(backup).map_err(|_| SnapshotPreviewError)?;
            }
        }
        if source_binding.exists() {
            fs::rename(&source_binding, &source_binding_backup)
                .map_err(|_| SnapshotPreviewError)?;
        }
        if snapshot.exists() && fs::rename(&snapshot, &snapshot_backup).is_err() {
            restore_file(&source_binding_backup, &source_binding);
            return Err(SnapshotPreviewError);
        }
        if fs::rename(&incoming, &snapshot).is_err() {
            restore_file(&snapshot_backup, &snapshot);
            restore_file(&source_binding_backup, &source_binding);
            return Err(SnapshotPreviewError);
        }
        if fs::rename(&incoming_binding, &source_binding).is_err() {
            let _ = fs::remove_file(&snapshot);
            restore_file(&snapshot_backup, &snapshot);
            restore_file(&source_binding_backup, &source_binding);
            return Err(SnapshotPreviewError);
        }
        for backup in [snapshot_backup, source_binding_backup] {
            if backup.exists() {
                let _ = fs::remove_file(backup);
            }
        }
        Ok(())
    }

    fn cleanup(&self, staging: &Path) {
        let _ = fs::remove_dir_all(staging);
    }
}

fn restore_file(backup: &Path, destination: &Path) {
    if backup.exists() {
        let _ = fs::rename(backup, destination);
    }
}

fn source_fingerprint(source: &XSourceReference) -> String {
    let mut digest = Sha256::new();
    digest.update(source.browser_id.as_bytes());
    digest.update([0]);
    digest.update(source.profile_id.as_bytes());
    format!("{:x}", digest.finalize())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

struct ActiveAcquisition {
    acquisition_id: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct AcquisitionSupervisor {
    active: Arc<Mutex<Option<ActiveAcquisition>>>,
}

impl AcquisitionSupervisor {
    pub fn is_active(&self) -> bool {
        self.active
            .lock()
            .map(|active| active.is_some())
            .unwrap_or(true)
    }

    pub fn start<F>(
        &self,
        runner: &BridgeRunner,
        request: XAcquisitionRequest,
        store: SnapshotStore,
        emit: F,
    ) -> Result<(), AcquisitionStartError>
    where
        F: Fn(AcquisitionEvent) + Send + Sync + 'static,
    {
        if !valid_identifier(&request.acquisition_id) {
            return Err(AcquisitionStartError::InvalidAcquisitionId);
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| AcquisitionStartError::OperationActive)?;
        if active.is_some() {
            return Err(AcquisitionStartError::OperationActive);
        }

        let source = request.source.clone();
        let staging = store.prepare(&request.acquisition_id, &source)?;
        let mut command = Command::new(&runner.node_path);
        command
            .arg(&runner.bridge_path)
            .current_dir(&staging)
            .env_clear();
        copy_required_process_environment(&mut command);
        let mut child = command
            .env("FT_DATA_DIR", &staging)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                store.cleanup(&staging);
                AcquisitionStartError::BridgeUnavailable
            })?;
        let Some(mut stdin) = child.stdin.take() else {
            stop_failed_start(&mut child, &store, &staging);
            return Err(AcquisitionStartError::BridgeUnavailable);
        };
        let Some(stdout) = child.stdout.take() else {
            stop_failed_start(&mut child, &store, &staging);
            return Err(AcquisitionStartError::BridgeUnavailable);
        };

        let acquisition_id = request.acquisition_id.clone();
        let wire_request = WireAcquisitionRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: acquisition_id.clone(),
            command: "acquireSnapshot",
            source: &request.source,
        };
        if serde_json::to_writer(&mut stdin, &wire_request).is_err()
            || stdin.write_all(b"\n").is_err()
            || stdin.flush().is_err()
        {
            stop_failed_start(&mut child, &store, &staging);
            return Err(AcquisitionStartError::BridgeUnavailable);
        }

        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(ActiveAcquisition {
            acquisition_id: acquisition_id.clone(),
            child: Arc::clone(&child),
            stdin,
            cancelled: Arc::clone(&cancelled),
        });
        drop(active);

        let active = Arc::clone(&self.active);
        let sink: Arc<dyn Fn(AcquisitionEvent) + Send + Sync> = Arc::new(emit);
        thread::spawn(move || {
            let mut terminal = None;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if line.len() > MAX_WIRE_LINE_BYTES {
                    break;
                }
                let Ok(message) = serde_json::from_str::<WireAcquisitionMessage>(&line) else {
                    break;
                };
                if message.protocol_version != PROTOCOL_VERSION
                    || message.request_id != acquisition_id
                {
                    break;
                }
                match message.message_type.as_str() {
                    "progress" => {
                        let Some(data) = message.data else {
                            break;
                        };
                        let Some(phase) = data.phase else {
                            break;
                        };
                        sink(AcquisitionEvent::Progress {
                            acquisition_id: acquisition_id.clone(),
                            phase,
                            completed: data.completed.unwrap_or(0),
                            total: data.total,
                        });
                    }
                    "result" => {
                        let Some(data) = message.data else {
                            break;
                        };
                        if data.media_downloaded != Some(false)
                            || store.promote(&staging, &source).is_err()
                        {
                            break;
                        }
                        terminal = Some(AcquisitionEvent::Completed {
                            acquisition_id: acquisition_id.clone(),
                            total: data.total.unwrap_or(0),
                            added: data.added.unwrap_or(0),
                            folders: data.folders.unwrap_or_default(),
                        });
                        break;
                    }
                    "cancelled" => {
                        terminal = Some(AcquisitionEvent::Cancelled {
                            acquisition_id: acquisition_id.clone(),
                        });
                        break;
                    }
                    "error" => {
                        let code = message.error.as_ref().map(|error| error.code.as_str());
                        terminal = Some(failure_event(
                            &acquisition_id,
                            code,
                            store.has_snapshot_for(&source),
                        ));
                        break;
                    }
                    _ => break,
                }
            }

            if let Ok(mut process) = child.lock() {
                let _ = process.kill();
                let _ = process.wait();
            }
            store.cleanup(&staging);
            if terminal.is_none() {
                terminal = Some(if cancelled.load(Ordering::SeqCst) {
                    AcquisitionEvent::Cancelled {
                        acquisition_id: acquisition_id.clone(),
                    }
                } else {
                    failure_event(&acquisition_id, None, store.has_snapshot_for(&source))
                });
            }
            if let Ok(mut current) = active.lock()
                && current
                    .as_ref()
                    .is_some_and(|entry| entry.acquisition_id == acquisition_id)
            {
                *current = None;
            }
            if let Some(event) = terminal {
                sink(event);
            }
        });

        Ok(())
    }

    pub fn cancel(&self, acquisition_id: &str) -> Result<(), AcquisitionStartError> {
        let (child, stdin, cancelled) = {
            let active = self
                .active
                .lock()
                .map_err(|_| AcquisitionStartError::OperationNotActive)?;
            let current = active
                .as_ref()
                .filter(|entry| entry.acquisition_id == acquisition_id)
                .ok_or(AcquisitionStartError::OperationNotActive)?;
            (
                Arc::clone(&current.child),
                Arc::clone(&current.stdin),
                Arc::clone(&current.cancelled),
            )
        };

        cancelled.store(true, Ordering::SeqCst);
        let cancel_request = WireCancellationRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "cancel".to_string(),
            command: "cancelAcquisition",
            acquisition_id,
        };
        if let Ok(mut input) = stdin.lock() {
            let _ = serde_json::to_writer(&mut *input, &cancel_request);
            let _ = input.write_all(b"\n");
            let _ = input.flush();
        }
        if let Ok(mut process) = child.lock() {
            let _ = process.kill();
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireAcquisitionRequest<'a> {
    protocol_version: u8,
    request_id: String,
    command: &'static str,
    source: &'a XSourceReference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireCancellationRequest<'a> {
    protocol_version: u8,
    request_id: String,
    command: &'static str,
    acquisition_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAcquisitionMessage {
    protocol_version: u8,
    request_id: String,
    #[serde(rename = "type")]
    message_type: String,
    data: Option<WireAcquisitionData>,
    error: Option<WireAcquisitionError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAcquisitionData {
    phase: Option<AcquisitionPhase>,
    completed: Option<u64>,
    total: Option<u64>,
    added: Option<u64>,
    folders: Option<Vec<String>>,
    media_downloaded: Option<bool>,
}

#[derive(Deserialize)]
struct WireAcquisitionError {
    code: String,
}

fn failure_event(
    acquisition_id: &str,
    code: Option<&str>,
    previous_snapshot_available: bool,
) -> AcquisitionEvent {
    let (code, message) = match code {
        Some("x_compatibility") => (
            AcquisitionFailureCode::XCompatibility,
            COMPATIBILITY_MESSAGE,
        ),
        Some("source_unavailable") => (
            AcquisitionFailureCode::SourceUnavailable,
            "The selected browser profile is no longer available.",
        ),
        _ => (
            AcquisitionFailureCode::Unexpected,
            GENERIC_ACQUISITION_MESSAGE,
        ),
    };
    AcquisitionEvent::Failed {
        acquisition_id: acquisition_id.to_string(),
        code,
        message: message.to_string(),
        previous_snapshot_available,
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn stop_failed_start(child: &mut Child, store: &SnapshotStore, staging: &Path) {
    let _ = child.kill();
    let _ = child.wait();
    store.cleanup(staging);
}

pub(super) fn copy_required_process_environment(command: &mut Command) {
    const ALLOWLIST: &[&str] = &[
        "APPDATA",
        "HOME",
        "LOCALAPPDATA",
        "PATH",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
        "XDG_CONFIG_HOME",
    ];
    for key in ALLOWLIST {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}
