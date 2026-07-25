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
        capability: Option<&str>,
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
        response_for_capability(response, capability)?
            .json()
            .map_err(|_| match capability {
                Some(capability) => missing_capability(capability),
                None => DestinationError::for_code(DestinationErrorCode::UnsupportedDestination),
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
            None,
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
        let bookmarks: BookmarkListResponse =
            self.get(&client, bookmarks_url, api_key, Some("bookmarks"))?;
        let _ = bookmarks.bookmarks;

        self.probe(
            &client,
            api_base.join("bookmarks").expect("static relative URL"),
            api_key,
            serde_json::json!({}),
            ProbeExpectation::InvalidRequest,
            "bookmark creation",
        )?;
        self.probe(
            &client,
            api_base
                .join("bookmarks/karakeep-transfer-capability-probe/tags")
                .expect("static relative URL"),
            api_key,
            serde_json::json!({ "tags": [] }),
            ProbeExpectation::MissingBookmark,
            "bookmark and tag delivery",
        )?;

        Ok(AuthenticatedDestination {
            user_id: user.id,
            name: user.name,
            email: user.email,
        })
    }
}

impl ReqwestKarakeepClient {
    fn probe(
        &self,
        client: &Client,
        url: Url,
        api_key: &str,
        body: serde_json::Value,
        expectation: ProbeExpectation,
        capability: &str,
    ) -> Result<(), DestinationError> {
        let response = client
            .post(url)
            .header(ACCEPT, "application/json")
            .bearer_auth(api_key)
            .json(&body)
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

        match response.status() {
            StatusCode::UNAUTHORIZED => Err(DestinationError::for_code(
                DestinationErrorCode::Authentication,
            )),
            StatusCode::FORBIDDEN
            | StatusCode::METHOD_NOT_ALLOWED
            | StatusCode::NOT_IMPLEMENTED => Err(missing_capability(capability)),
            StatusCode::BAD_REQUEST if expectation == ProbeExpectation::InvalidRequest => Ok(()),
            StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND
                if expectation == ProbeExpectation::MissingBookmark =>
            {
                Ok(())
            }
            StatusCode::TOO_MANY_REQUESTS => {
                Err(DestinationError::for_code(DestinationErrorCode::Network))
            }
            status if status.is_server_error() => {
                Err(DestinationError::for_code(DestinationErrorCode::Network))
            }
            _ => Err(missing_capability(capability)),
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ProbeExpectation {
    InvalidRequest,
    MissingBookmark,
}

fn response_for_capability(
    response: Response,
    capability: Option<&str>,
) -> Result<Response, DestinationError> {
    match response.status() {
        status if status.is_success() => Ok(response),
        StatusCode::UNAUTHORIZED => Err(DestinationError::for_code(
            DestinationErrorCode::Authentication,
        )),
        StatusCode::FORBIDDEN => match capability {
            Some(capability) => Err(missing_capability(capability)),
            None => Err(DestinationError::for_code(
                DestinationErrorCode::Authentication,
            )),
        },
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => match capability {
            Some(capability) => Err(missing_capability(capability)),
            None => Err(DestinationError::for_code(
                DestinationErrorCode::UnsupportedDestination,
            )),
        },
        _ => Err(DestinationError::for_code(DestinationErrorCode::Network)),
    }
}

fn missing_capability(capability: &str) -> DestinationError {
    DestinationError::new(
        DestinationErrorCode::MissingCapability,
        format!(
            "This Karakeep destination does not provide the required {capability} capability. Use an API key with bookmark read/write access."
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
