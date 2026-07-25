use karakeep_transfer_lib::destination::{
    DestinationErrorCode, KarakeepClient, ReqwestKarakeepClient, normalize_destination_url,
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
};

struct Response {
    status: u16,
    body: &'static str,
}

fn fake_karakeep(
    responses: Vec<Response>,
) -> (String, mpsc::Receiver<Vec<String>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake Karakeep");
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::channel();
    let server = thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 8192];
            let length = stream.read(&mut buffer).expect("read request");
            requests.push(String::from_utf8_lossy(&buffer[..length]).into_owned());
            let reason = match response.status {
                200 => "OK",
                401 => "Unauthorized",
                403 => "Forbidden",
                404 => "Not Found",
                _ => "Error",
            };
            write!(
                stream,
                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.status,
                reason,
                response.body.len(),
                response.body
            )
            .expect("write response");
        }
        sender.send(requests).expect("return requests");
    });
    (format!("http://{address}"), receiver, server)
}

#[test]
fn validation_identifies_the_user_and_checks_delivery_capabilities_without_writes() {
    let (server_url, requests, server) = fake_karakeep(vec![
        Response {
            status: 200,
            body: r#"{"id":"user-1","name":"Ada","email":"ada@example.com","localUser":true}"#,
        },
        Response {
            status: 200,
            body: r#"{"bookmarks":[],"nextCursor":null}"#,
        },
        Response {
            status: 400,
            body: r#"{"message":"invalid bookmark payload"}"#,
        },
        Response {
            status: 404,
            body: r#"{"message":"bookmark not found"}"#,
        },
    ]);
    let destination = normalize_destination_url(&server_url, false).expect("loopback URL");

    let identity = ReqwestKarakeepClient::new()
        .validate(&destination, "request-canary-key")
        .expect("compatible destination validates");

    assert_eq!(identity.user_id, "user-1");
    assert_eq!(identity.name.as_deref(), Some("Ada"));
    assert_eq!(identity.email.as_deref(), Some("ada@example.com"));

    server.join().unwrap();
    let requests = requests.recv().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].starts_with("GET /api/v1/users/me HTTP/1.1"));
    assert!(requests[1].starts_with("GET /api/v1/bookmarks?"));
    assert!(requests[2].starts_with("POST /api/v1/bookmarks HTTP/1.1"));
    assert!(requests[2].ends_with("\r\n\r\n{}"));
    assert!(
        requests[3]
            .starts_with("POST /api/v1/bookmarks/karakeep-transfer-capability-probe/tags HTTP/1.1")
    );
    assert!(requests[3].ends_with("\r\n\r\n{\"tags\":[]}"));
    assert!(
        requests
            .iter()
            .all(|request| request.contains("authorization: Bearer request-canary-key"))
    );
    assert!(requests.iter().all(|request| {
        !request.contains("\"type\":\"link\"") && !request.contains("\"url\":")
    }));
}

#[test]
fn authentication_failures_are_specific_and_redacted() {
    let (server_url, _requests, server) = fake_karakeep(vec![Response {
        status: 401,
        body: r#"{"message":"Rejected rejected-canary-key"}"#,
    }]);
    let destination = normalize_destination_url(&server_url, false).expect("loopback URL");

    let error = ReqwestKarakeepClient::new()
        .validate(&destination, "rejected-canary-key")
        .expect_err("invalid credentials fail");

    server.join().unwrap();
    assert_eq!(error.code(), DestinationErrorCode::Authentication);
    assert!(!error.to_string().contains("rejected-canary-key"));
}

#[test]
fn absent_bookmark_or_tag_contracts_are_missing_capabilities() {
    let (server_url, _requests, server) = fake_karakeep(vec![
        Response {
            status: 200,
            body: r#"{"id":"user-1","name":"Ada","email":null,"localUser":true}"#,
        },
        Response {
            status: 404,
            body: r#"{"message":"not found"}"#,
        },
    ]);
    let destination = normalize_destination_url(&server_url, false).expect("loopback URL");

    let error = ReqwestKarakeepClient::new()
        .validate(&destination, "limited-key")
        .expect_err("missing bookmark contract fails");

    server.join().unwrap();
    assert_eq!(error.code(), DestinationErrorCode::MissingCapability);
    assert!(error.to_string().contains("bookmarks"));
}

#[test]
fn a_read_only_key_is_rejected_before_it_can_be_remembered() {
    let (server_url, _requests, server) = fake_karakeep(vec![
        Response {
            status: 200,
            body: r#"{"id":"user-1","name":"Ada","email":null,"localUser":true}"#,
        },
        Response {
            status: 200,
            body: r#"{"bookmarks":[],"nextCursor":null}"#,
        },
        Response {
            status: 400,
            body: r#"{"message":"invalid bookmark payload"}"#,
        },
        Response {
            status: 403,
            body: r#"{"message":"API key is missing required scope: bookmarks:readwrite"}"#,
        },
    ]);
    let destination = normalize_destination_url(&server_url, false).expect("loopback URL");

    let error = ReqwestKarakeepClient::new()
        .validate(&destination, "read-only-key")
        .expect_err("delivery needs bookmark write access");

    server.join().unwrap();
    assert_eq!(error.code(), DestinationErrorCode::MissingCapability);
    assert!(error.to_string().contains("bookmark and tag delivery"));
}

#[test]
fn transient_probe_failures_are_reported_as_recoverable_network_errors() {
    let (server_url, _requests, server) = fake_karakeep(vec![
        Response {
            status: 200,
            body: r#"{"id":"user-1","name":"Ada","email":null,"localUser":true}"#,
        },
        Response {
            status: 200,
            body: r#"{"bookmarks":[],"nextCursor":null}"#,
        },
        Response {
            status: 400,
            body: r#"{"message":"invalid bookmark payload"}"#,
        },
        Response {
            status: 503,
            body: r#"{"message":"temporarily unavailable"}"#,
        },
    ]);
    let destination = normalize_destination_url(&server_url, false).expect("loopback URL");

    let error = ReqwestKarakeepClient::new()
        .validate(&destination, "request-canary-key")
        .expect_err("a transient probe failure must remain retryable");

    server.join().unwrap();
    assert_eq!(error.code(), DestinationErrorCode::Network);
}
