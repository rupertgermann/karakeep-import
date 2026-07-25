use super::{
    DestinationError, DestinationErrorCode, NormalizedDestination, validate_destination_redirect,
};
use crate::karakeep::{
    ApiError, ApiErrorKind, BookmarkDraft, BookmarkOrigin, EnsuredBookmark, KarakeepApi,
    KarakeepBookmark, RequestCancellation,
};
use reqwest::{
    Client, RequestBuilder, StatusCode,
    header::{ACCEPT, RETRY_AFTER},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
    thread,
    time::Duration,
};
use url::Url;

const USER_AGENT: &str = concat!(
    "Karakeep-Transfer/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/rupertgermann/karakeep-import)"
);
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub(super) struct ReqwestDeliveryApi {
    client: Client,
    api_base: Url,
    api_key: String,
}

impl ReqwestDeliveryApi {
    pub(super) fn new(
        destination: NormalizedDestination,
        api_key: String,
        timeout: Duration,
    ) -> Result<Self, DestinationError> {
        let redirect_destination = destination.clone();
        let client = Client::builder()
            .timeout(timeout)
            .user_agent(USER_AGENT)
            .redirect(Policy::custom(move |attempt| {
                if attempt.previous().len() >= 10 {
                    return attempt.error("Karakeep returned too many redirects");
                }
                let Some(previous) = attempt.previous().last() else {
                    return attempt.follow();
                };
                match validate_destination_redirect(
                    &redirect_destination,
                    previous.as_str(),
                    attempt.url().as_str(),
                ) {
                    Ok(()) => attempt.follow(),
                    Err(error) => attempt.error(error.to_string()),
                }
            }))
            .build()
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::Network))?;
        let api_base = Url::parse(&format!("{}/", destination.api_base()))
            .map_err(|_| DestinationError::for_code(DestinationErrorCode::InvalidServerUrl))?;
        Ok(Self {
            client,
            api_base,
            api_key,
        })
    }

    fn authenticated(&self, request: RequestBuilder) -> RequestBuilder {
        request
            .header(ACCEPT, "application/json")
            .bearer_auth(&self.api_key)
    }

    fn endpoint(&self, relative: &str) -> Url {
        self.api_base
            .join(relative)
            .expect("static relative Karakeep endpoint")
    }

    fn bookmark_tags_endpoint(&self, bookmark_id: &str) -> Url {
        let mut url = self.api_base.clone();
        url.path_segments_mut()
            .expect("HTTP destination supports path segments")
            .pop_if_empty()
            .push("bookmarks")
            .push(bookmark_id)
            .push("tags");
        url
    }

    fn execute<T>(
        &self,
        cancellation: &dyn RequestCancellation,
        future: impl Future<Output = Result<T, ApiError>>,
    ) -> Result<T, ApiError> {
        run_cancellable(cancellation, future)
    }
}

impl KarakeepApi for ReqwestDeliveryApi {
    fn ensure_bookmark(
        &self,
        draft: &BookmarkDraft,
        cancellation: &dyn RequestCancellation,
    ) -> Result<EnsuredBookmark, ApiError> {
        let request = CreateBookmarkRequest {
            bookmark_type: "link",
            url: &draft.url,
            title: draft.title.as_deref(),
            note: draft.note.as_deref(),
            created_at: draft.created_at.as_deref(),
        };
        let request =
            self.authenticated(self.client.post(self.endpoint("bookmarks")).json(&request));
        self.execute(cancellation, async move {
            let response = request.send().await.map_err(transport_error)?;
            let status = response.status();
            if status != StatusCode::OK && status != StatusCode::CREATED {
                return Err(status_error(status, response.headers()));
            }
            let bookmark = response
                .json::<BookmarkResponse>()
                .await
                .map_err(response_contract_error)?;
            if bookmark.id.trim().is_empty() {
                return Err(response_contract_error(()));
            }
            Ok(EnsuredBookmark {
                bookmark: KarakeepBookmark {
                    id: bookmark.id,
                    human_tags: bookmark
                        .tags
                        .into_iter()
                        .filter(|tag| tag.attached_by == "human")
                        .map(|tag| tag.name)
                        .collect(),
                },
                origin: if status == StatusCode::CREATED {
                    BookmarkOrigin::Created
                } else {
                    BookmarkOrigin::Existing
                },
            })
        })
    }

    fn attach_tags(
        &self,
        bookmark_id: &str,
        tags: &[String],
        cancellation: &dyn RequestCancellation,
    ) -> Result<(), ApiError> {
        if tags.is_empty() {
            return Ok(());
        }
        let body = AttachTagsRequest {
            tags: tags
                .iter()
                .map(|tag| AttachTag {
                    tag_name: tag,
                    attached_by: "human",
                })
                .collect(),
        };
        let request = self.authenticated(
            self.client
                .post(self.bookmark_tags_endpoint(bookmark_id))
                .json(&body),
        );
        self.execute(cancellation, async move {
            let response = request.send().await.map_err(transport_error)?;
            if response.status() != StatusCode::OK {
                return Err(status_error(response.status(), response.headers()));
            }
            let response = response
                .json::<AttachTagsResponse>()
                .await
                .map_err(response_contract_error)?;
            let _ = response.attached;
            Ok(())
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateBookmarkRequest<'a> {
    #[serde(rename = "type")]
    bookmark_type: &'static str,
    url: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<&'a str>,
}

#[derive(Deserialize)]
struct BookmarkResponse {
    id: String,
    tags: Vec<BookmarkTagResponse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookmarkTagResponse {
    name: String,
    attached_by: String,
}

#[derive(Serialize)]
struct AttachTagsRequest<'a> {
    tags: Vec<AttachTag<'a>>,
}

#[derive(Deserialize)]
struct AttachTagsResponse {
    attached: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachTag<'a> {
    tag_name: &'a str,
    attached_by: &'static str,
}

fn transport_error(error: reqwest::Error) -> ApiError {
    if error.is_timeout() {
        ApiError::new(ApiErrorKind::Timeout, "The Karakeep request timed out.")
    } else if error.is_redirect() {
        ApiError::new(
            ApiErrorKind::Permanent,
            "Karakeep returned an unsafe or excessive redirect.",
        )
    } else {
        ApiError::new(
            ApiErrorKind::Network,
            "Karakeep could not be reached over the network.",
        )
    }
}

fn response_contract_error(_error: impl Sized) -> ApiError {
    ApiError::new(
        ApiErrorKind::Permanent,
        "Karakeep returned an incompatible bookmark response.",
    )
}

fn status_error(status: StatusCode, headers: &reqwest::header::HeaderMap) -> ApiError {
    match status {
        StatusCode::TOO_MANY_REQUESTS => ApiError::new(
            ApiErrorKind::RateLimited {
                retry_after: retry_after(headers),
            },
            "Karakeep asked the app to slow down.",
        ),
        StatusCode::REQUEST_TIMEOUT => {
            ApiError::new(ApiErrorKind::Timeout, "The Karakeep request timed out.")
        }
        status if status.is_server_error() => ApiError::new(
            ApiErrorKind::Server,
            "Karakeep encountered a temporary server error.",
        ),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ApiError::new(
            ApiErrorKind::Permanent,
            "Karakeep rejected the saved API key. Reconnect the destination.",
        ),
        _ => ApiError::new(
            ApiErrorKind::Permanent,
            format!("Karakeep rejected the request with HTTP {status}."),
        ),
    }
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

fn run_cancellable<T>(
    cancellation: &dyn RequestCancellation,
    future: impl Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    if cancellation.is_cancelled() {
        return Err(cancelled_error());
    }

    let waker = Arc::new(Mutex::new(None::<Waker>));
    let done = Arc::new(AtomicBool::new(false));
    thread::scope(|scope| {
        let watcher_waker = Arc::clone(&waker);
        let watcher_done = Arc::clone(&done);
        scope.spawn(move || {
            while !watcher_done.load(Ordering::Acquire) {
                if cancellation.is_cancelled()
                    && let Some(waker) = watcher_waker.lock().expect("waker lock").as_ref()
                {
                    waker.wake_by_ref();
                }
                thread::sleep(CANCELLATION_POLL_INTERVAL);
            }
        });

        let completion = CompletionFlag(Arc::clone(&done));
        let result = tauri::async_runtime::block_on(CancellableRequest {
            future: Box::pin(future),
            cancellation,
            waker,
        });
        drop(completion);
        result
    })
}

struct CompletionFlag(Arc<AtomicBool>);

impl Drop for CompletionFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct CancellableRequest<'a, F> {
    future: Pin<Box<F>>,
    cancellation: &'a dyn RequestCancellation,
    waker: Arc<Mutex<Option<Waker>>>,
}

impl<F, T> Future for CancellableRequest<'_, F>
where
    F: Future<Output = Result<T, ApiError>>,
{
    type Output = Result<T, ApiError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        if this.cancellation.is_cancelled() {
            return Poll::Ready(Err(cancelled_error()));
        }
        *this.waker.lock().expect("waker lock") = Some(context.waker().clone());
        if this.cancellation.is_cancelled() {
            return Poll::Ready(Err(cancelled_error()));
        }
        this.future.as_mut().poll(context)
    }
}

fn cancelled_error() -> ApiError {
    ApiError::new(ApiErrorKind::Network, "The Karakeep request was cancelled.")
}
