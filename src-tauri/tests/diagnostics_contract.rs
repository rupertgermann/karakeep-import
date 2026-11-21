use karakeep_transfer_lib::{
    diagnostics::{
        ComponentStatus, DiagnosticFailure, DiagnosticsInput, DiagnosticsStore, StorageSummary,
        build_explicit_export,
    },
    ledger::DeliveryLedger,
    redaction::{REDACTED, SecretRedactor},
    updates::{GITHUB_RELEASES_URL, manual_update_check},
    versions::ComponentVersions,
};

const KARAKEEP_KEY_CANARY: &str = "ak2_KARAKEEP_KEY_MUST_NOT_ESCAPE";
const X_SESSION_CANARY: &str = "x_session_MUST_NOT_ESCAPE";

#[test]
fn diagnostics_store_redacts_canaries_at_the_export_boundary() {
    let store = DiagnosticsStore::new(
        DiagnosticsInput {
            source: ComponentStatus::Unavailable,
            destination: ComponentStatus::Ready,
            storage: StorageSummary {
                data_directory: format!(
                    "/private/{X_SESSION_CANARY}/karakeep-transfer/{KARAKEEP_KEY_CANARY}"
                ),
                snapshot_bytes: 1_024,
                ledger_bytes: 2_048,
            },
            last_failure: Some(DiagnosticFailure::BrowserAccess),
        },
        ComponentVersions::new("0.1.0", "1.3.22", "22.17.0", "3"),
        SecretRedactor::new([KARAKEEP_KEY_CANARY, X_SESSION_CANARY]),
    );

    let serialized = serde_json::to_string(
        &store
            .explicit_export()
            .expect("diagnostics state is available"),
    )
    .expect("diagnostics export serializes");

    assert!(!serialized.contains(KARAKEEP_KEY_CANARY));
    assert!(!serialized.contains(X_SESSION_CANARY));
    assert!(serialized.contains(REDACTED));
    assert!(serialized.contains("browserAccess"));
}

#[test]
fn explicit_export_is_local_redacted_and_has_no_bookmark_content_field() {
    let redactor = SecretRedactor::new([KARAKEEP_KEY_CANARY, X_SESSION_CANARY]);
    let versions = ComponentVersions::new("0.1.0", "1.3.22", "22.17.0", "3");
    let input = DiagnosticsInput {
        source: ComponentStatus::Unavailable,
        destination: ComponentStatus::Ready,
        storage: StorageSummary {
            data_directory: format!(
                "/private/{X_SESSION_CANARY}/karakeep-transfer/{KARAKEEP_KEY_CANARY}"
            ),
            snapshot_bytes: 1_024,
            ledger_bytes: 2_048,
        },
        last_failure: Some(DiagnosticFailure::DestinationAuthentication),
    };

    let export = build_explicit_export(&input, versions, &redactor);
    let serialized = serde_json::to_string(&export).expect("diagnostics export serializes");

    assert!(export.generated_by_user_action);
    assert!(!export.includes_bookmark_content);
    assert!(!export.telemetry_enabled);
    assert!(!serialized.contains(KARAKEEP_KEY_CANARY));
    assert!(!serialized.contains(X_SESSION_CANARY));
    assert!(!serialized.contains("bookmarkContent"));
    assert!(!serialized.contains("bookmarks"));
    assert!(serialized.contains(REDACTED));
    assert!(serialized.contains("destinationAuthentication"));
    assert!(
        export
            .last_failure
            .as_ref()
            .expect("failure is included")
            .guidance
            .contains("API key")
    );
}

#[test]
fn diagnostics_report_every_supported_component_version() {
    let versions = ComponentVersions::new("0.1.0", "1.3.22", "22.17.0", "3");

    assert_eq!(versions.app, "0.1.0");
    assert_eq!(versions.field_theory, "1.3.22");
    assert_eq!(versions.node, "22.17.0");
    assert_eq!(versions.schema, "3");
    assert_eq!(versions.karakeep_baseline, "0.32.0");
}

#[test]
fn current_versions_come_from_repository_build_inputs() {
    let versions = ComponentVersions::current();
    let ledger = DeliveryLedger::open_in_memory().expect("ledger initializes");

    assert_eq!(versions.field_theory, "1.3.22");
    assert_eq!(versions.node, "26.13.1");
    assert_eq!(
        versions.schema,
        ledger.schema_version().expect("schema version").to_string()
    );
}

#[test]
fn missing_bundled_component_metadata_is_explicit() {
    let versions = ComponentVersions::from_build_metadata("0.1.0", None, None, None);

    assert_eq!(versions.field_theory, "not bundled");
    assert_eq!(versions.node, "not bundled");
    assert_eq!(versions.schema, "not initialized");
}

#[test]
fn compatibility_and_access_failures_have_safe_actionable_explanations() {
    let cases = [
        (
            DiagnosticFailure::BrowserAccess,
            "Browser access unavailable",
            "browser profile",
        ),
        (
            DiagnosticFailure::DestinationAuthentication,
            "Karakeep authentication failed",
            "API key",
        ),
        (
            DiagnosticFailure::DestinationCompatibility,
            "Karakeep destination is not compatible",
            "0.32.0",
        ),
        (
            DiagnosticFailure::Network,
            "Network request failed",
            "HTTPS",
        ),
        (
            DiagnosticFailure::XCompatibility,
            "X acquisition is temporarily unavailable",
            "signed app update",
        ),
    ];

    for (failure, expected_title, expected_guidance) in cases {
        let explanation = failure.explanation();

        assert_eq!(explanation.title, expected_title);
        assert!(explanation.guidance.contains(expected_guidance));
    }
}

#[test]
fn manual_update_check_only_points_to_the_signed_release_channel() {
    let result = manual_update_check();

    assert!(result.requested_by_user);
    assert_eq!(
        result.release_page,
        "https://github.com/rupertgermann/karakeep-import/releases/latest"
    );
    assert_eq!(result.release_page, GITHUB_RELEASES_URL);
    assert!(!result.downloads_update);
    assert!(!result.executes_update);
}
