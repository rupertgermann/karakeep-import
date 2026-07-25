use serde::{Deserialize, Serialize};
use std::fmt;
use url::{Host, Url};

mod client;
mod settings;
mod vault;

pub use client::ReqwestKarakeepClient;
pub use settings::FileDestinationSettings;
pub use vault::NativeCredentialVault;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DestinationErrorCode {
    Authentication,
    InsecureDestination,
    InvalidServerUrl,
    MissingCapability,
    Network,
    Storage,
    UnsupportedDestination,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationError {
    code: DestinationErrorCode,
    message: String,
}

impl DestinationError {
    pub fn code(&self) -> DestinationErrorCode {
        self.code
    }

    fn new(code: DestinationErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn for_code(code: DestinationErrorCode) -> Self {
        let message = match code {
            DestinationErrorCode::Authentication => {
                "Karakeep rejected the API key. Check the key and try again."
            }
            DestinationErrorCode::InsecureDestination => {
                "This destination does not satisfy the connection security policy."
            }
            DestinationErrorCode::InvalidServerUrl => "Enter a valid Karakeep server URL.",
            DestinationErrorCode::MissingCapability => {
                "This Karakeep destination is missing a required delivery capability."
            }
            DestinationErrorCode::Network => {
                "Karakeep could not be reached. Check the server and network."
            }
            DestinationErrorCode::Storage => {
                "The Karakeep connection could not be stored securely."
            }
            DestinationErrorCode::UnsupportedDestination => {
                "The server did not return the expected Karakeep API contract."
            }
        };
        Self::new(code, message)
    }
}

impl fmt::Display for DestinationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DestinationError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedDestination {
    server_url: String,
    api_base: String,
    allow_insecure_http: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationSummary {
    pub server_url: String,
    pub user_id: String,
    pub display_name: String,
    pub email: Option<String>,
    pub insecure_http: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedDestination {
    pub user_id: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectDestinationInput {
    pub server: String,
    pub api_key: String,
    pub allow_insecure_http: bool,
}

pub trait KarakeepClient {
    fn validate(
        &self,
        destination: &NormalizedDestination,
        api_key: &str,
    ) -> Result<AuthenticatedDestination, DestinationError>;
}

pub trait CredentialVault {
    fn load(&self) -> Result<Option<String>, DestinationError>;
    fn save(&self, api_key: &str) -> Result<(), DestinationError>;
    fn delete(&self) -> Result<(), DestinationError>;
}

pub trait DestinationSettings {
    fn load(&self) -> Result<Option<DestinationSummary>, DestinationError>;
    fn save(&self, destination: &DestinationSummary) -> Result<(), DestinationError>;
    fn delete(&self) -> Result<(), DestinationError>;
}

pub struct DestinationService<C, V, S> {
    client: C,
    vault: V,
    settings: S,
}

impl<C, V, S> DestinationService<C, V, S>
where
    C: KarakeepClient,
    V: CredentialVault,
    S: DestinationSettings,
{
    pub fn new(client: C, vault: V, settings: S) -> Self {
        Self {
            client,
            vault,
            settings,
        }
    }

    pub fn connect(
        &self,
        input: ConnectDestinationInput,
    ) -> Result<DestinationSummary, DestinationError> {
        let api_key = input.api_key.trim();
        if api_key.is_empty() {
            return Err(DestinationError::for_code(
                DestinationErrorCode::Authentication,
            ));
        }

        let normalized = normalize_destination_url(&input.server, input.allow_insecure_http)?;
        let identity = self.client.validate(&normalized, api_key)?;
        let destination = DestinationSummary {
            server_url: normalized.server_url().to_owned(),
            user_id: identity.user_id.clone(),
            display_name: identity
                .name
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| identity.email.clone())
                .unwrap_or(identity.user_id),
            email: identity.email,
            insecure_http: normalized.allows_insecure_http(),
        };

        let previous_key = self.vault.load()?;
        self.vault.save(api_key)?;
        if let Err(error) = self.settings.save(&destination) {
            match previous_key {
                Some(previous_key) => {
                    let _ = self.vault.save(&previous_key);
                }
                None => {
                    let _ = self.vault.delete();
                }
            }
            return Err(error);
        }

        Ok(destination)
    }

    pub fn status(&self) -> Result<Option<DestinationSummary>, DestinationError> {
        let Some(destination) = self.settings.load()? else {
            return Ok(None);
        };
        match self.vault.load()? {
            Some(api_key) if !api_key.is_empty() => Ok(Some(destination)),
            _ => Ok(None),
        }
    }

    pub fn forget(&self) -> Result<(), DestinationError> {
        self.vault.delete()?;
        self.settings.delete()
    }
}

impl NormalizedDestination {
    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    pub fn api_base(&self) -> &str {
        &self.api_base
    }

    pub fn allows_insecure_http(&self) -> bool {
        self.allow_insecure_http
    }
}

pub fn normalize_destination_url(
    server: &str,
    allow_insecure_http: bool,
) -> Result<NormalizedDestination, DestinationError> {
    let mut url = Url::parse(server.trim()).map_err(|_| {
        DestinationError::new(
            DestinationErrorCode::InvalidServerUrl,
            "Enter an absolute Karakeep server URL.",
        )
    })?;

    if url.cannot_be_a_base()
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(DestinationError::new(
            DestinationErrorCode::InvalidServerUrl,
            "The Karakeep server URL must not contain credentials, a query, or a fragment.",
        ));
    }

    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" if allow_insecure_http => {}
        "http" => {
            return Err(DestinationError::new(
                DestinationErrorCode::InsecureDestination,
                "HTTP is blocked for this destination. Use HTTPS or explicitly accept the private-network warning.",
            ));
        }
        _ => {
            return Err(DestinationError::new(
                DestinationErrorCode::InvalidServerUrl,
                "The Karakeep server URL must use HTTPS or HTTP.",
            ));
        }
    }

    let mut path = url.path().trim_end_matches('/').to_owned();
    if let Some((prefix, _)) = path.split_once("/dashboard") {
        path = prefix.trim_end_matches('/').to_owned();
    }
    if path.ends_with("/api/v1") {
        path.truncate(path.len() - "/api/v1".len());
    }

    url.set_path(if path.is_empty() { "/" } else { &path });
    let server_url = url.as_str().trim_end_matches('/').to_owned();
    url.set_path(&format!("{}/api/v1", path.trim_end_matches('/')));
    let api_base = url.as_str().trim_end_matches('/').to_owned();

    Ok(NormalizedDestination {
        server_url,
        api_base,
        allow_insecure_http: url.scheme() == "http" && !is_loopback(&url) && allow_insecure_http,
    })
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

pub fn validate_destination_redirect(
    destination: &NormalizedDestination,
    from: &str,
    to: &str,
) -> Result<(), DestinationError> {
    let from = Url::parse(from)
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::InsecureDestination))?;
    let to = Url::parse(to)
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::InsecureDestination))?;
    let destination_url = Url::parse(destination.server_url())
        .map_err(|_| DestinationError::for_code(DestinationErrorCode::InsecureDestination))?;

    if from.scheme() == "https" && to.scheme() == "http" {
        return Err(DestinationError::new(
            DestinationErrorCode::InsecureDestination,
            "Karakeep attempted an HTTPS-to-HTTP redirect, so the connection was stopped.",
        ));
    }

    if to.origin() != destination_url.origin() {
        return Err(DestinationError::new(
            DestinationErrorCode::InsecureDestination,
            "Karakeep attempted to redirect authentication to another destination.",
        ));
    }

    if to.scheme() == "http" && !is_loopback(&to) && !destination.allows_insecure_http() {
        return Err(DestinationError::for_code(
            DestinationErrorCode::InsecureDestination,
        ));
    }

    Ok(())
}
