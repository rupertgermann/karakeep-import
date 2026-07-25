use super::{DestinationError, DestinationErrorCode, DestinationSettings, DestinationSummary};
use std::{fs, io::ErrorKind, path::PathBuf};

pub struct FileDestinationSettings {
    path: PathBuf,
}

impl FileDestinationSettings {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl DestinationSettings for FileDestinationSettings {
    fn load(&self) -> Result<Option<DestinationSummary>, DestinationError> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(_) => {
                return Err(DestinationError::for_code(DestinationErrorCode::Storage));
            }
        };
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))
    }

    fn save(&self, destination: &DestinationSummary) -> Result<(), DestinationError> {
        let contents = serde_json::to_vec_pretty(destination)
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))?;
        }
        fs::write(&self.path, contents)
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::Storage))
    }

    fn delete(&self) -> Result<(), DestinationError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(DestinationError::for_code(DestinationErrorCode::Storage)),
        }
    }
}
