use serde_json::Value;

fn tauri_config() -> Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("Tauri config is valid JSON")
}

#[test]
fn desktop_csp_disallows_remote_code_and_eval() {
    let config = tauri_config();
    let csp = config
        .pointer("/app/security/csp")
        .and_then(Value::as_str)
        .expect("desktop CSP is configured");

    assert!(csp.contains("default-src 'self'"));
    assert!(!csp.contains("'unsafe-eval'"));
    assert!(!csp.contains("https:"));
    assert!(!csp.contains("data:"));
}

#[test]
fn desktop_configuration_has_no_automatic_updater() {
    let config = tauri_config();

    assert!(
        config.pointer("/plugins/updater").is_none(),
        "updates must remain a manual GitHub Releases action"
    );
}
