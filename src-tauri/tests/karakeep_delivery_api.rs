use karakeep_transfer_lib::{
    delivery::{
        DeliveryConfig, DeliveryLedger, DeliveryRecord, DeliverySource, DestinationId, LedgerError,
        LedgerStatus, NoopProgressSink, PendingDelivery, RetryPolicy,
    },
    destination::{
        CredentialVault, DestinationError, DestinationService, DestinationSettings,
        DestinationSummary, ReqwestKarakeepClient,
    },
    karakeep::{ApiErrorKind, BookmarkDraft, BookmarkOrigin, KarakeepApi, RequestCancellation},
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone)]
struct MemoryVault(Option<String>);

impl CredentialVault for MemoryVault {
    fn load(&self) -> Result<Option<String>, DestinationError> {
        Ok(self.0.clone())
    }

    fn save(&self, _api_key: &str) -> Result<(), DestinationError> {
        unreachable!("delivery tests never replace credentials")
    }

    fn delete(&self) -> Result<(), DestinationError> {
        unreachable!("delivery tests never forget credentials")
    }
}

#[derive(Clone)]
struct MemorySettings(Option<DestinationSummary>);

impl DestinationSettings for MemorySettings {
    fn load(&self) -> Result<Option<DestinationSummary>, DestinationError> {
        Ok(self.0.clone())
    }

    fn save(&self, _destination: &DestinationSummary) -> Result<(), DestinationError> {
        unreachable!("delivery tests never replace settings")
    }

    fn delete(&self) -> Result<(), DestinationError> {
        unreachable!("delivery tests never forget settings")
    }
}

#[derive(Clone, Default)]
struct TestCancellation(Arc<AtomicBool>);

impl TestCancellation {
    fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

impl RequestCancellation for TestCancellation {
    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

struct PlannedResponse {
    status: u16,
    headers: Vec<(&'static str, &'static str)>,
    body: &'static str,
    delay: Duration,
}

impl PlannedResponse {
    fn json(status: u16, body: &'static str) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body,
            delay: Duration::ZERO,
        }
    }
}

#[derive(Debug)]
struct ObservedRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl ObservedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("request body is JSON")
    }
}

fn scripted_server(
    responses: Vec<PlannedResponse>,
) -> (
    String,
    mpsc::Receiver<Vec<ObservedRequest>>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake Karakeep");
    let address = listener.local_addr().expect("fake Karakeep address");
    let (sender, receiver) = mpsc::channel();
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let (mut stream, _) = listener.accept().expect("accept request");
            requests.push(read_request(&mut stream));
            if !response.delay.is_zero() {
                thread::sleep(response.delay);
            }
            write_response(&mut stream, response);
        }
        sender.send(requests).expect("return requests");
    });
    (format!("http://{address}"), receiver, server)
}

fn read_request(stream: &mut TcpStream) -> ObservedRequest {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set request read timeout");
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let (header_end, content_length) = loop {
        let read = stream.read(&mut buffer).expect("read request");
        assert!(read > 0, "connection closed before request completed");
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(header_end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let header_end = header_end + 4;
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().expect("content length"))
                })
                .unwrap_or(0);
            break (header_end, content_length);
        }
    };
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("read request body");
        assert!(read > 0, "connection closed before request body completed");
        bytes.extend_from_slice(&buffer[..read]);
    }

    let header_text =
        String::from_utf8(bytes[..header_end - 4].to_vec()).expect("request headers are UTF-8");
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().expect("request line");
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().expect("request method").to_owned();
    let path = request_parts.next().expect("request path").to_owned();
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.to_owned(), value.trim().to_owned()))
        })
        .collect();
    ObservedRequest {
        method,
        path,
        headers,
        body: bytes[header_end..header_end + content_length].to_vec(),
    }
}

fn write_response(stream: &mut TcpStream, response: PlannedResponse) {
    let reason = match response.status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        408 => "Request Timeout",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let extra_headers = response
        .headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.status,
        reason,
        extra_headers,
        response.body.len(),
        response.body
    )
    .expect("write response");
}

fn delivery_api(server_url: String, api_key: &str, timeout: Duration) -> Arc<dyn KarakeepApi> {
    let service = DestinationService::new(
        ReqwestKarakeepClient::with_timeout(timeout),
        MemoryVault(Some(api_key.to_owned())),
        MemorySettings(Some(DestinationSummary {
            server_url,
            user_id: "user-1".into(),
            display_name: "Ada".into(),
            email: None,
            insecure_http: false,
        })),
    );
    service
        .delivery_api()
        .expect("remembered destination creates a delivery API")
}

fn draft() -> BookmarkDraft {
    BookmarkDraft {
        url: "https://x.com/example/status/123".into(),
        title: Some("A useful post".into()),
        note: Some("Post text and context".into()),
        created_at: Some("2024-07-24T12:34:56Z".into()),
    }
}

#[test]
fn delivery_api_cannot_be_created_without_the_saved_vault_credential() {
    let service = DestinationService::new(
        ReqwestKarakeepClient::with_timeout(Duration::from_millis(50)),
        MemoryVault(None),
        MemorySettings(Some(DestinationSummary {
            server_url: "http://127.0.0.1:9".into(),
            user_id: "user-1".into(),
            display_name: "Ada".into(),
            email: None,
            insecure_http: false,
        })),
    );

    let error = match service.delivery_api() {
        Ok(_) => panic!("delivery requires the credential vault entry"),
        Err(error) => error,
    };

    assert_eq!(
        error.code(),
        karakeep_transfer_lib::destination::DestinationErrorCode::Authentication
    );
    assert_eq!(
        error.to_string(),
        "Reconnect Karakeep before starting delivery."
    );
}

struct OneRecord;

impl DeliverySource for OneRecord {
    fn records(&self) -> Result<Vec<DeliveryRecord>, karakeep_transfer_lib::delivery::SourceError> {
        Ok(vec![DeliveryRecord {
            source_id: "tweet-123".into(),
            bookmark: draft(),
            required_tags: vec!["twitter".into(), "Folder A".into()],
        }])
    }
}

#[derive(Default)]
struct CompletedLedger(Mutex<bool>);

impl DeliveryLedger for CompletedLedger {
    fn status(
        &self,
        _destination: &DestinationId,
        _source_id: &str,
    ) -> Result<LedgerStatus, LedgerError> {
        Ok(LedgerStatus::Pending { attempts: 0 })
    }

    fn record_pending(
        &self,
        _destination: &DestinationId,
        _pending: PendingDelivery,
    ) -> Result<(), LedgerError> {
        Ok(())
    }

    fn record_delivered(
        &self,
        _destination: &DestinationId,
        _source_id: &str,
        _bookmark_id: &str,
        _origin: BookmarkOrigin,
    ) -> Result<(), LedgerError> {
        *self.0.lock().expect("ledger lock") = true;
        Ok(())
    }
}

#[test]
fn create_or_existing_uses_the_vault_credential_and_preserves_returned_human_tags() {
    let (server_url, requests, server) = scripted_server(vec![
        PlannedResponse::json(
            201,
            r#"{"id":"created-1","tags":[{"id":"tag-1","name":"twitter","attachedBy":"human"},{"id":"tag-2","name":"generated","attachedBy":"ai"}]}"#,
        ),
        PlannedResponse::json(
            200,
            r#"{"id":"existing-1","tags":[{"id":"tag-3","name":"Folder A","attachedBy":"human"}]}"#,
        ),
    ]);
    let api = delivery_api(server_url, "delivery-vault-canary", Duration::from_secs(2));

    let created = api
        .ensure_bookmark(&draft(), &TestCancellation::default())
        .expect("new bookmark");
    let existing = api
        .ensure_bookmark(&draft(), &TestCancellation::default())
        .expect("existing bookmark");

    assert_eq!(created.origin, BookmarkOrigin::Created);
    assert_eq!(created.bookmark.id, "created-1");
    assert_eq!(created.bookmark.human_tags, vec!["twitter"]);
    assert_eq!(existing.origin, BookmarkOrigin::Existing);
    assert_eq!(existing.bookmark.id, "existing-1");
    assert_eq!(existing.bookmark.human_tags, vec!["Folder A"]);

    server.join().expect("fake Karakeep joins");
    let requests = requests.recv().expect("captured requests");
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/v1/bookmarks");
        assert_eq!(
            request.header("authorization"),
            Some("Bearer delivery-vault-canary")
        );
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert!(!request.path.contains("delivery-vault-canary"));
        assert_eq!(
            request.json(),
            json!({
                "type": "link",
                "url": "https://x.com/example/status/123",
                "title": "A useful post",
                "note": "Post text and context",
                "createdAt": "2024-07-24T12:34:56Z"
            })
        );
    }
}

#[test]
fn tag_attachment_sends_only_the_supplied_missing_human_tags_and_escapes_the_id() {
    let (server_url, requests, server) = scripted_server(vec![PlannedResponse::json(
        200,
        r#"{"attached":["tag-1","tag-2"]}"#,
    )]);
    let api = delivery_api(server_url, "delivery-vault-canary", Duration::from_secs(2));

    api.attach_tags(
        "bookmark/with space",
        &["Folder A".into(), "twitter".into()],
        &TestCancellation::default(),
    )
    .expect("missing tags attach");

    server.join().expect("fake Karakeep joins");
    let requests = requests.recv().expect("captured requests");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(
        requests[0].path,
        "/api/v1/bookmarks/bookmark%2Fwith%20space/tags"
    );
    assert_eq!(
        requests[0].header("authorization"),
        Some("Bearer delivery-vault-canary")
    );
    assert_eq!(requests[0].header("content-type"), Some("application/json"));
    assert!(!String::from_utf8_lossy(&requests[0].body).contains("delivery-vault-canary"));
    assert_eq!(
        requests[0].json(),
        json!({
            "tags": [
                {"tagName": "Folder A", "attachedBy": "human"},
                {"tagName": "twitter", "attachedBy": "human"}
            ]
        })
    );
}

#[test]
fn no_tag_request_is_sent_when_the_delivery_engine_has_no_missing_tags() {
    let api = delivery_api(
        "http://127.0.0.1:9".into(),
        "delivery-vault-canary",
        Duration::from_millis(50),
    );

    api.attach_tags("bookmark-1", &[], &TestCancellation::default())
        .expect("an empty tag delta needs no HTTP request");
}

#[test]
fn delivery_engine_attaches_only_tags_missing_from_an_existing_bookmark() {
    let (server_url, requests, server) = scripted_server(vec![
        PlannedResponse::json(
            200,
            r#"{"id":"existing-1","tags":[{"id":"tag-1","name":"TWITTER","attachedBy":"human"}]}"#,
        ),
        PlannedResponse::json(200, r#"{"attached":["tag-2"]}"#),
    ]);
    let api = delivery_api(server_url, "delivery-vault-canary", Duration::from_secs(2));
    let ledger = Arc::new(CompletedLedger::default());
    let engine = karakeep_transfer_lib::delivery::DeliveryEngine::new(
        api,
        ledger.clone(),
        DeliveryConfig {
            max_concurrency: 1,
            requests_per_second: 1000.0,
            retry: RetryPolicy {
                max_retries: 0,
                base_delay: Duration::ZERO,
                max_delay: Duration::ZERO,
            },
        },
    )
    .expect("delivery engine");

    let report = engine
        .run(
            &OneRecord,
            &DestinationId::new("destination-1"),
            &TestCancellation::default(),
            &NoopProgressSink,
        )
        .expect("existing bookmark delivery");

    assert_eq!(report.totals.existing, 1);
    assert_eq!(report.totals.delivered, 1);
    assert!(*ledger.0.lock().expect("ledger lock"));
    server.join().expect("fake Karakeep joins");
    let requests = requests.recv().expect("captured requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, "/api/v1/bookmarks");
    assert_eq!(requests[1].path, "/api/v1/bookmarks/existing-1/tags");
    assert_eq!(
        requests[1].json(),
        json!({
            "tags": [
                {"tagName": "Folder A", "attachedBy": "human"}
            ]
        })
    );
}

#[test]
fn connection_failures_are_retryable_network_errors() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve unused port");
    let server_url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let api = delivery_api(
        server_url,
        "network-vault-canary",
        Duration::from_millis(100),
    );

    let error = api
        .ensure_bookmark(&draft(), &TestCancellation::default())
        .expect_err("connection refusal fails");

    assert_eq!(error.kind, ApiErrorKind::Network);
    assert!(error.is_retryable());
    assert!(!error.message.contains("network-vault-canary"));
}

#[test]
fn authentication_redirects_never_forward_the_vault_credential_to_another_origin() {
    let target = TcpListener::bind("127.0.0.1:0").expect("bind redirect target");
    let target_url = format!("http://{}/api/v1/bookmarks", target.local_addr().unwrap());
    let source = TcpListener::bind("127.0.0.1:0").expect("bind redirect source");
    let server_url = format!("http://{}", source.local_addr().unwrap());
    let source_server = thread::spawn(move || {
        let (mut stream, _) = source.accept().expect("accept source request");
        let _request = read_request(&mut stream);
        write!(
            stream,
            "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .expect("write redirect");
    });
    let api = delivery_api(
        server_url,
        "redirect-vault-canary",
        Duration::from_millis(250),
    );

    let error = api
        .ensure_bookmark(&draft(), &TestCancellation::default())
        .expect_err("cross-origin redirect is blocked");

    source_server.join().expect("redirect source joins");
    target
        .set_nonblocking(true)
        .expect("inspect redirect target without blocking");
    assert!(
        target.accept().is_err(),
        "the redirect target must never receive an authenticated request"
    );
    assert_eq!(error.kind, ApiErrorKind::Permanent);
    assert!(!error.message.contains("redirect-vault-canary"));
}

#[test]
fn response_statuses_are_safe_and_retry_aware() {
    let cases = [
        (
            PlannedResponse {
                status: 429,
                headers: vec![("Retry-After", "7")],
                body: r#"{"message":"delivery-vault-canary rate limited"}"#,
                delay: Duration::ZERO,
            },
            ApiErrorKind::RateLimited {
                retry_after: Some(Duration::from_secs(7)),
            },
        ),
        (
            PlannedResponse::json(503, r#"{"message":"delivery-vault-canary unavailable"}"#),
            ApiErrorKind::Server,
        ),
        (
            PlannedResponse::json(408, r#"{"message":"delivery-vault-canary timed out"}"#),
            ApiErrorKind::Timeout,
        ),
        (
            PlannedResponse::json(401, r#"{"message":"delivery-vault-canary rejected"}"#),
            ApiErrorKind::Permanent,
        ),
    ];

    for (response, expected_kind) in cases {
        let (server_url, _requests, server) = scripted_server(vec![response]);
        let api = delivery_api(server_url, "delivery-vault-canary", Duration::from_secs(2));
        let error = api
            .ensure_bookmark(&draft(), &TestCancellation::default())
            .expect_err("status fails safely");
        server.join().expect("fake Karakeep joins");

        assert_eq!(error.kind, expected_kind);
        assert!(!error.message.contains("delivery-vault-canary"));
    }
}

#[test]
fn an_incompatible_tag_response_cannot_mark_delivery_successful() {
    let (server_url, _requests, server) =
        scripted_server(vec![PlannedResponse::json(200, r#"{"unexpected":[]}"#)]);
    let api = delivery_api(server_url, "delivery-vault-canary", Duration::from_secs(2));

    let error = api
        .attach_tags(
            "bookmark-1",
            &["twitter".into()],
            &TestCancellation::default(),
        )
        .expect_err("invalid tag response fails closed");

    server.join().expect("fake Karakeep joins");
    assert_eq!(error.kind, ApiErrorKind::Permanent);
    assert!(!error.message.contains("delivery-vault-canary"));
}

#[test]
fn request_timeout_is_classified_without_exposing_the_credential() {
    let (server_url, _requests, server) = scripted_server(vec![PlannedResponse {
        status: 201,
        headers: Vec::new(),
        body: r#"{"id":"late","tags":[]}"#,
        delay: Duration::from_millis(250),
    }]);
    let api = delivery_api(
        server_url,
        "timeout-vault-canary",
        Duration::from_millis(50),
    );

    let error = api
        .ensure_bookmark(&draft(), &TestCancellation::default())
        .expect_err("slow response times out");

    server.join().expect("fake Karakeep joins");
    assert_eq!(error.kind, ApiErrorKind::Timeout);
    assert!(!error.message.contains("timeout-vault-canary"));
}

#[test]
fn active_http_work_stops_promptly_when_cancelled() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake Karakeep");
    let server_url = format!("http://{}", listener.local_addr().unwrap());
    let (accepted_sender, accepted_receiver) = mpsc::channel();
    let (closed_sender, closed_receiver) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        let _request = read_request(&mut stream);
        accepted_sender.send(()).expect("signal request accepted");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("set close observation timeout");
        let mut byte = [0_u8; 1];
        let closed = stream.read(&mut byte).is_ok_and(|read| read == 0);
        closed_sender.send(closed).expect("report connection close");
    });
    let api = delivery_api(server_url, "cancel-vault-canary", Duration::from_secs(3));
    let cancellation = TestCancellation::default();
    let worker_cancellation = cancellation.clone();
    let started = Instant::now();
    let worker = thread::spawn(move || api.ensure_bookmark(&draft(), &worker_cancellation));

    accepted_receiver
        .recv_timeout(Duration::from_secs(1))
        .expect("request reached server");
    cancellation.cancel();
    let error = worker
        .join()
        .expect("delivery worker joins")
        .expect_err("cancelled request fails");

    assert!(
        started.elapsed() < Duration::from_secs(1),
        "cancellation should not wait for the request timeout"
    );
    assert!(!error.message.contains("cancel-vault-canary"));
    assert!(
        closed_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("observe connection close"),
        "dropping the active request must close its connection"
    );
    server.join().expect("fake Karakeep joins");
}
