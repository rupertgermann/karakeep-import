use std::path::PathBuf;

use karakeep_transfer_lib::fieldtheory::{
    BridgeCommand, BridgeRequest, BridgeRunner, DiscoveryResponse,
};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("bridge-fixture.mjs")
}

#[test]
fn consumes_one_versioned_ndjson_response_from_the_bridge_process() {
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let response: DiscoveryResponse = runner
        .request(&BridgeRequest::new(
            "rust-discover-1",
            BridgeCommand::DiscoverSources,
        ))
        .expect("bridge response");

    assert_eq!(response.browsers.len(), 1);
    assert_eq!(response.browsers[0].id, "chrome");
    assert_eq!(response.browsers[0].profiles[0].id, "Default");
}

#[test]
fn never_returns_bridge_stderr_that_may_contain_session_values() {
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());
    let error = runner
        .request::<DiscoveryResponse>(&BridgeRequest::new(
            "secret-error-1",
            BridgeCommand::DiscoverSources,
        ))
        .expect_err("bridge exits unsuccessfully");

    assert!(!error.to_string().contains("auth-token-canary-8472"));
    assert_eq!(
        error.to_string(),
        "The Field Theory bridge could not complete the request."
    );
}
