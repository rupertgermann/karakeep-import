use std::{
    ffi::{OsStr, OsString},
    path::PathBuf,
};

use karakeep_transfer_lib::fieldtheory::{
    BridgeCommand, BridgeRequest, BridgeRunner, DiscoveryResponse,
};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("bridge-fixture.mjs")
}

struct ScopedEnvironment {
    key: &'static str,
    previous: Option<OsString>,
}

impl ScopedEnvironment {
    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        // SAFETY: the previous process value is restored when the guard drops.
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, previous }
    }
}

impl Drop for ScopedEnvironment {
    fn drop(&mut self) {
        // SAFETY: restores the process environment captured by `set`.
        unsafe {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
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

#[test]
fn discovery_bridge_clears_inherited_secrets_and_keeps_only_required_environment() {
    let _api_key = ScopedEnvironment::set(
        "KARAKEEP_API_KEY",
        "karakeep-key-canary-discovery-environment",
    );
    let _unrelated =
        ScopedEnvironment::set("FIELD_THEORY_UNRELATED_CANARY", "unrelated-secret-canary");
    let _required = ScopedEnvironment::set("XDG_CONFIG_HOME", "required-environment-canary");
    let runner = BridgeRunner::new(PathBuf::from("node"), fixture());

    let response: DiscoveryResponse = runner
        .request(&BridgeRequest::new(
            "environment-boundary-1",
            BridgeCommand::DiscoverSources,
        ))
        .expect("bridge response");

    assert_eq!(response.browsers[0].id, "environment-clean");
    assert_eq!(response.browsers[0].name, "required-environment-present");
}
