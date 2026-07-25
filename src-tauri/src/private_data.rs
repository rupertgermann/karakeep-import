use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateDataSummary {
    pub ledger_path: PathBuf,
    pub snapshot_path: PathBuf,
    pub acquisition_state_path: PathBuf,
    pub ledger_bytes: u64,
    pub snapshot_bytes: u64,
    pub acquisition_state_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateTransferData {
    ledger_path: PathBuf,
    snapshot_path: PathBuf,
    acquisition_state_path: PathBuf,
}

impl PrivateTransferData {
    pub fn new(
        ledger_path: impl Into<PathBuf>,
        snapshot_path: impl Into<PathBuf>,
        acquisition_state_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            ledger_path: ledger_path.into(),
            snapshot_path: snapshot_path.into(),
            acquisition_state_path: acquisition_state_path.into(),
        }
    }

    pub fn inspect(&self) -> io::Result<PrivateDataSummary> {
        let ledger_bytes = path_size(&self.ledger_path)?
            + path_size(&sqlite_sidecar(&self.ledger_path, "-wal"))?
            + path_size(&sqlite_sidecar(&self.ledger_path, "-shm"))?;
        let snapshot_bytes = path_size(&self.snapshot_path)?;
        let acquisition_state_bytes = path_size(&self.acquisition_state_path)?;
        Ok(PrivateDataSummary {
            ledger_path: self.ledger_path.clone(),
            snapshot_path: self.snapshot_path.clone(),
            acquisition_state_path: self.acquisition_state_path.clone(),
            ledger_bytes,
            snapshot_bytes,
            acquisition_state_bytes,
            total_bytes: ledger_bytes + snapshot_bytes + acquisition_state_bytes,
        })
    }

    pub fn replace_x_source(&self) -> io::Result<()> {
        remove_path(&self.snapshot_path)?;
        remove_path(&self.acquisition_state_path)
    }

    pub fn delete_if_confirmed(&self, confirmed: bool) -> io::Result<bool> {
        if !confirmed {
            return Ok(false);
        }
        remove_path(&self.snapshot_path)?;
        remove_path(&self.acquisition_state_path)?;
        remove_path(&self.ledger_path)?;
        remove_path(&sqlite_sidecar(&self.ledger_path, "-wal"))?;
        remove_path(&sqlite_sidecar(&self.ledger_path, "-shm"))?;
        Ok(true)
    }
}

fn path_size(path: &Path) -> io::Result<u64> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() {
        return Ok(metadata.len());
    }
    let mut total = 0;
    for entry in fs::read_dir(path)? {
        total += path_size(&entry?.path())?;
    }
    Ok(total)
}

fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn sqlite_sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}
