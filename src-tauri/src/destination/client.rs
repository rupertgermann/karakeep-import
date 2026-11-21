use super::{
    AuthenticatedDestination, DestinationError, DestinationErrorCode, KarakeepClient,
    NormalizedDestination, validate_destination_redirect,
};
use reqwest::{
    StatusCode,
    blocking::{Client, Response},
    header::ACCEPT,
    redirect::Policy,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::time::Duration;
use url::Url;

const USER_AGENT: &str = concat!(
    "Karakeep-Transfer/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/rupertgermann/karakeep-import)"
);

pub struct ReqwestKarakeepClient {
    timeout: Duration,
}

impl ReqwestKarakeepClient {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_timeout(timeout: Duration) -> Self {
        Self { timeout }
    }

    fn http_client(&self, destination: &NormalizedDestination) -> Result<Client, DestinationError> {
        let destination = destination.clone();
        Client::builder()
            .timeout(self.timeout)
            .user_agent(USER_AGENT)
            .redirect(Policy::custom(move |attempt| {
                let Some(previous) = attempt.previous().last() else {
                    return attempt.follow();
                };
                match validate_destination_redirect(
                    &destination,
                    previous.as_str(),
                    attempt.url().as_str(),
                ) {
                    Ok(()) => attempt.follow(),
                    Err(error) => attempt.error(error.to_string()),
                }
            }))
            .build()
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::Network))
    }

    fn get<T: DeserializeOwned>(
        &self,
        client: &Client,
        url: Url,
        api_key: &str,
        endpoint: ValidationEndpoint<'_>,
    ) -> Result<T, DestinationError> {
        let response = client
            .get(url)
            .header(ACCEPT, "application/json")
            .bearer_auth(api_key)
            .send()
            .map_err(|error| {
                if error.is_redirect() {
                    DestinationError::new(
                        DestinationErrorCode::InsecureDestination,
                        "Karakeep returned a redirect that could expose the API key.",
                    )
                } else {
                    DestinationError::for_code(DestinationErrorCode::Network)
                }
            })?;
        response_for_endpoint(response, endpoint)?
            .json()
            .map_err(|_| match endpoint {
                ValidationEndpoint::Identity => {
                    DestinationError::for_code(DestinationErrorCode::UnsupportedDestination)
                }
                ValidationEndpoint::Capability(capability) => missing_capability(capability),
            })
    }
}

impl Default for ReqwestKarakeepClient {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(20),
        }
    }
}

impl KarakeepClient for ReqwestKarakeepClient {
    fn validate(
        &self,
        destination: &NormalizedDestination,
        api_key: &str,
    ) -> Result<AuthenticatedDestination, DestinationError> {
        let client = self.http_client(destination)?;
        let api_base = Url::parse(&format!("{}/", destination.api_base()))
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::InvalidServerUrl))?;

        let user: UserResponse = self.get(
            &client,
            api_base.join("users/me").expect("static relative URL"),
            api_key,
            ValidationEndpoint::Identity,
        )?;
        if user.id.trim().is_empty() {
            return Err(DestinationError::for_code(
                DestinationErrorCode::UnsupportedDestination,
            ));
        }

        let mut bookmarks_url = api_base.join("bookmarks").expect("static relative URL");
        bookmarks_url
            .query_pairs_mut()
            .append_pair("limit", "1")
            .append_pair("includeContent", "false");
        let bookmarks: BookmarkListResponse = self.get(
            &client,
            bookmarks_url,
            api_key,
            ValidationEndpoint::Capability("bookmarks"),
        )?;
        let _ = bookmarks.bookmarks;

        Ok(AuthenticatedDestination {
            user_id: user.id,
            name: user.name,
            email: user.email,
        })
    }

    fn request_timeout(&self) -> Duration {
        self.timeout
    }
}

#[derive(Clone, Copy)]
enum ValidationEndpoint<'a> {
    Identity,
    Capability(&'a str),
}

fn response_for_endpoint(
    response: Response,
    endpoint: ValidationEndpoint<'_>,
) -> Result<Response, DestinationError> {
    match response.status() {
        status if status.is_success() => Ok(response),
        StatusCode::UNAUTHORIZED => Err(DestinationError::for_code(
            DestinationErrorCode::Authentication,
        )),
        StatusCode::FORBIDDEN => match endpoint {
            ValidationEndpoint::Identity => Err(missing_capability("user identity")),
            ValidationEndpoint::Capability(capability) => Err(missing_capability(capability)),
        },
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => match endpoint {
            ValidationEndpoint::Identity => Err(DestinationError::for_code(
                DestinationErrorCode::UnsupportedDestination,
            )),
            ValidationEndpoint::Capability(capability) => Err(missing_capability(capability)),
        },
        _ => Err(DestinationError::for_code(DestinationErrorCode::Network)),
    }
}

fn missing_capability(capability: &str) -> DestinationError {
    DestinationError::new(
        DestinationErrorCode::MissingCapability,
        format!(
            "This Karakeep destination does not provide the required {capability} capability. Use an API key with users:read and bookmarks:readwrite access, or full access."
        ),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserResponse {
    id: String,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize)]
struct BookmarkListResponse {
    bookmarks: Vec<serde_json::Value>,
}
