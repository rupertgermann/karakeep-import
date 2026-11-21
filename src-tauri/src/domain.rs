use std::{error::Error, fmt};

use url::Url;

#[derive(Debug)]
pub enum DomainError {
    InvalidDestinationUrl(url::ParseError),
    UnsupportedDestinationScheme,
    MissingDestinationHost,
    DestinationContainsCredentials,
    EmptyAuthenticatedUser,
    InvalidBookmarkKey,
    InvalidFailureCode,
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidDestinationUrl(_) => "destination URL is invalid",
            Self::UnsupportedDestinationScheme => "destination URL must use HTTP or HTTPS",
            Self::MissingDestinationHost => "destination URL must include a host",
            Self::DestinationContainsCredentials => "destination URL must not contain credentials",
            Self::EmptyAuthenticatedUser => "authenticated user identity must not be empty",
            Self::InvalidBookmarkKey => "bookmark key must contain a source and identifier",
            Self::InvalidFailureCode => {
                "failure code must be a short uppercase redacted identifier"
            }
        };
        formatter.write_str(message)
    }
}

impl Error for DomainError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidDestinationUrl(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct DestinationIdentity {
    normalized_server: String,
    authenticated_user: String,
}

impl DestinationIdentity {
    pub fn new(server: &str, authenticated_user: &str) -> Result<Self, DomainError> {
        let mut url = Url::parse(server).map_err(DomainError::InvalidDestinationUrl)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(DomainError::UnsupportedDestinationScheme);
        }
        if url.host().is_none() {
            return Err(DomainError::MissingDestinationHost);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(DomainError::DestinationContainsCredentials);
        }

        url.set_query(None);
        url.set_fragment(None);
        let normalized_path = url.path().trim_end_matches('/').to_owned();
        if normalized_path.is_empty() {
            url.set_path("/");
        } else {
            url.set_path(&normalized_path);
        }
        let mut normalized_server = url.to_string();
        if url.path() == "/" && normalized_server.ends_with('/') {
            normalized_server.pop();
        }

        let authenticated_user = authenticated_user.trim();
        if authenticated_user.is_empty() {
            return Err(DomainError::EmptyAuthenticatedUser);
        }

        Ok(Self {
            normalized_server,
            authenticated_user: authenticated_user.to_owned(),
        })
    }

    pub fn normalized_server(&self) -> &str {
        &self.normalized_server
    }

    pub fn authenticated_user(&self) -> &str {
        &self.authenticated_user
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct BookmarkKey {
    source: String,
    identifier: String,
}

impl BookmarkKey {
    pub fn new(source: &str, identifier: &str) -> Result<Self, DomainError> {
        let source = source.trim();
        let identifier = identifier.trim();
        if source.is_empty() || identifier.is_empty() {
            return Err(DomainError::InvalidBookmarkKey);
        }
        Ok(Self {
            source: source.to_owned(),
            identifier: identifier.to_owned(),
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn identifier(&self) -> &str {
        &self.identifier
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TimestampMillis(pub i64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryOutcome {
    Created,
    Existing,
}

impl DeliveryOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Existing => "existing",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value {
            "created" => Some(Self::Created),
            "existing" => Some(Self::Existing),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryStage {
    CreateBookmark,
    AttachTags,
    Network,
    Cancelled,
}

impl DeliveryStage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CreateBookmark => "create_bookmark",
            Self::AttachTags => "attach_tags",
            Self::Network => "network",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailureCode(String);

impl FailureCode {
    pub fn new(value: &str) -> Result<Self, DomainError> {
        if value.is_empty()
            || value.len() > 64
            || !value.bytes().all(|byte| {
                byte.is_ascii_uppercase() || byte.is_ascii_digit() || b"_-".contains(&byte)
            })
        {
            return Err(DomainError::InvalidFailureCode);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryAttempt {
    Delivered {
        karakeep_bookmark_id: String,
        outcome: DeliveryOutcome,
    },
    Failed {
        stage: DeliveryStage,
        code: FailureCode,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunStatus {
    Running,
    Completed,
    PartiallyCompleted,
    Interrupted,
}

impl RunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::PartiallyCompleted => "partially_completed",
            Self::Interrupted => "interrupted",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "partially_completed" => Some(Self::PartiallyCompleted),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }
}
