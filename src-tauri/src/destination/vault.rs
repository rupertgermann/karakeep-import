use super::{CredentialVault, DestinationError, DestinationErrorCode};
use keyring::{Entry, Error as KeyringError};
use std::sync::Mutex;

const SERVICE: &str = "io.github.rupertgermann.karakeeptransfer";
const ACCOUNT: &str = "active-destination-api-key";

pub struct NativeCredentialVault {
    entry: Mutex<Entry>,
}

impl NativeCredentialVault {
    pub fn new() -> Result<Self, DestinationError> {
        let entry = Entry::new(SERVICE, ACCOUNT)
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::CredentialVault))?;
        Ok(Self {
            entry: Mutex::new(entry),
        })
    }

    fn entry(&self) -> Result<std::sync::MutexGuard<'_, Entry>, DestinationError> {
        self.entry
            .lock()
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::CredentialVault))
    }
}

impl CredentialVault for NativeCredentialVault {
    fn load(&self) -> Result<Option<String>, DestinationError> {
        match self.entry()?.get_password() {
            Ok(credential) => Ok(Some(credential)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(DestinationError::for_code(
                DestinationErrorCode::CredentialVault,
            )),
        }
    }

    fn save(&self, credential: &str) -> Result<(), DestinationError> {
        self.entry()?
            .set_password(credential)
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::CredentialVault))
    }

    fn delete(&self) -> Result<(), DestinationError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(DestinationError::for_code(
                DestinationErrorCode::CredentialVault,
            )),
        }
    }
}
