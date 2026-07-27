use karakeep_transfer_lib::destination::{
    AuthenticatedDestination, ConnectDestinationInput, CredentialVault, DestinationError,
    DestinationErrorCode, DestinationService, DestinationSettings, DestinationSummary,
    KarakeepClient, normalize_destination_url, validate_destination_redirect,
};
use std::{cell::RefCell, rc::Rc};

#[test]
fn https_and_loopback_destinations_are_normalized_to_the_api_contract() {
    let https = normalize_destination_url("https://keep.example/dashboard/bookmarks/", false)
        .expect("https destination is accepted");
    assert_eq!(https.server_url(), "https://keep.example");
    assert_eq!(https.api_base(), "https://keep.example/api/v1");

    let loopback = normalize_destination_url("http://127.0.0.1:3000/api/v1/", false)
        .expect("loopback http is accepted");
    assert_eq!(loopback.server_url(), "http://127.0.0.1:3000");
    assert_eq!(loopback.api_base(), "http://127.0.0.1:3000/api/v1");
}

#[test]
fn non_loopback_http_requires_a_destination_specific_exception() {
    let error = normalize_destination_url("http://keep.private", false)
        .expect_err("plain http is blocked by default");
    assert_eq!(error.code(), DestinationErrorCode::InsecureDestination);

    let accepted = normalize_destination_url("http://keep.private", true)
        .expect("an explicit exception accepts this exact destination");
    assert_eq!(accepted.server_url(), "http://keep.private");
}

#[test]
fn credentials_queries_and_fragments_are_rejected_from_server_urls() {
    for server in [
        "https://user:password@keep.example",
        "https://keep.example?api_key=secret",
        "https://keep.example/#secret",
    ] {
        let error =
            normalize_destination_url(server, false).expect_err("secret-bearing URLs are rejected");
        assert_eq!(error.code(), DestinationErrorCode::InvalidServerUrl);
    }
}

#[test]
fn redirects_cannot_downgrade_https_or_reuse_an_http_exception_elsewhere() {
    let https = normalize_destination_url("https://keep.example", false).unwrap();
    let error = validate_destination_redirect(
        &https,
        "https://keep.example/api/v1/users/me",
        "http://keep.example/api/v1/users/me",
    )
    .expect_err("https downgrade is rejected");
    assert_eq!(error.code(), DestinationErrorCode::InsecureDestination);

    let private_http = normalize_destination_url("http://keep.private", true).unwrap();
    let error = validate_destination_redirect(
        &private_http,
        "http://keep.private/api/v1/users/me",
        "http://other.private/api/v1/users/me",
    )
    .expect_err("the exception belongs to one destination");
    assert_eq!(error.code(), DestinationErrorCode::InsecureDestination);
}

struct FakeKarakeepClient {
    result: Result<AuthenticatedDestination, DestinationErrorCode>,
    observed_key: RefCell<Option<String>>,
}

impl KarakeepClient for FakeKarakeepClient {
    fn validate(
        &self,
        _destination: &karakeep_transfer_lib::destination::NormalizedDestination,
        api_key: &str,
    ) -> Result<AuthenticatedDestination, DestinationError> {
        self.observed_key.replace(Some(api_key.to_owned()));
        self.result.clone().map_err(DestinationError::for_code)
    }
}

#[derive(Clone, Default)]
struct MemoryVault(Rc<RefCell<Option<String>>>);

impl CredentialVault for MemoryVault {
    fn load(&self) -> Result<Option<String>, DestinationError> {
        Ok(self.0.borrow().clone())
    }

    fn save(&self, api_key: &str) -> Result<(), DestinationError> {
        self.0.replace(Some(api_key.to_owned()));
        Ok(())
    }

    fn delete(&self) -> Result<(), DestinationError> {
        self.0.replace(None);
        Ok(())
    }
}

#[derive(Clone, Default)]
struct MemorySettings(Rc<RefCell<Option<DestinationSummary>>>);

impl DestinationSettings for MemorySettings {
    fn load(&self) -> Result<Option<DestinationSummary>, DestinationError> {
        Ok(self.0.borrow().clone())
    }

    fn save(&self, destination: &DestinationSummary) -> Result<(), DestinationError> {
        self.0.replace(Some(destination.clone()));
        Ok(())
    }

    fn delete(&self) -> Result<(), DestinationError> {
        self.0.replace(None);
        Ok(())
    }
}

fn compatible_user() -> AuthenticatedDestination {
    AuthenticatedDestination {
        user_id: "user-1".to_owned(),
        name: Some("Ada Example".to_owned()),
        email: Some("ada@example.com".to_owned()),
    }
}

#[test]
fn a_validated_destination_is_remembered_without_exposing_its_key() {
    let client = FakeKarakeepClient {
        result: Ok(compatible_user()),
        observed_key: RefCell::new(None),
    };
    let vault = MemoryVault::default();
    let settings = MemorySettings::default();
    let vault_observer = vault.clone();
    let settings_observer = settings.clone();
    let service = DestinationService::new(client, vault.clone(), settings.clone());

    let destination = service
        .connect(ConnectDestinationInput {
            server: "https://keep.example".to_owned(),
            api_key: "vault-canary-key".to_owned(),
            allow_insecure_http: false,
        })
        .expect("compatible destination connects");

    assert_eq!(destination.server_url, "https://keep.example");
    assert_eq!(destination.user_id, "user-1");
    assert_eq!(destination.display_name, "Ada Example");
    assert_eq!(
        service.status().expect("status loads"),
        Some(destination.clone())
    );
    assert_eq!(
        vault_observer.load().expect("vault loads").as_deref(),
        Some("vault-canary-key")
    );
    let persisted = serde_json::to_string(&settings_observer.load().unwrap()).unwrap();
    assert!(!persisted.contains("vault-canary-key"));

    let restarted = DestinationService::new(
        FakeKarakeepClient {
            result: Ok(compatible_user()),
            observed_key: RefCell::new(None),
        },
        vault,
        settings,
    );
    assert_eq!(restarted.status().unwrap(), Some(destination));
}

#[test]
fn failed_validation_does_not_replace_a_remembered_connection_or_leak_the_key() {
    let client = FakeKarakeepClient {
        result: Err(DestinationErrorCode::Authentication),
        observed_key: RefCell::new(None),
    };
    let vault = MemoryVault::default();
    vault.save("previous-key").unwrap();
    let settings = MemorySettings::default();
    let previous = DestinationSummary {
        server_url: "https://old.example".to_owned(),
        user_id: "old-user".to_owned(),
        display_name: "Previous Destination".to_owned(),
        email: None,
        insecure_http: false,
    };
    settings.save(&previous).unwrap();
    let vault_observer = vault.clone();
    let service = DestinationService::new(client, vault, settings);

    let error = service
        .connect(ConnectDestinationInput {
            server: "https://new.example".to_owned(),
            api_key: "rejected-canary-key".to_owned(),
            allow_insecure_http: false,
        })
        .expect_err("authentication is rejected");

    assert_eq!(error.code(), DestinationErrorCode::Authentication);
    assert!(!error.to_string().contains("rejected-canary-key"));
    assert_eq!(service.status().unwrap(), Some(previous));
    assert_eq!(
        vault_observer.load().unwrap().as_deref(),
        Some("previous-key")
    );
}

#[derive(Clone)]
struct RestoreFailingVault {
    value: Rc<RefCell<Option<String>>>,
}

impl CredentialVault for RestoreFailingVault {
    fn load(&self) -> Result<Option<String>, DestinationError> {
        Ok(self.value.borrow().clone())
    }

    fn save(&self, api_key: &str) -> Result<(), DestinationError> {
        if api_key == "previous-key" {
            return Err(DestinationError::for_code(DestinationErrorCode::Storage));
        }
        self.value.replace(Some(api_key.to_owned()));
        Ok(())
    }

    fn delete(&self) -> Result<(), DestinationError> {
        self.value.replace(None);
        Ok(())
    }
}

#[derive(Clone)]
struct SaveFailingSettings(Rc<RefCell<Option<DestinationSummary>>>);

impl DestinationSettings for SaveFailingSettings {
    fn load(&self) -> Result<Option<DestinationSummary>, DestinationError> {
        Ok(self.0.borrow().clone())
    }

    fn save(&self, _destination: &DestinationSummary) -> Result<(), DestinationError> {
        Err(DestinationError::for_code(DestinationErrorCode::Storage))
    }

    fn delete(&self) -> Result<(), DestinationError> {
        self.0.replace(None);
        Ok(())
    }
}

#[test]
fn failed_credential_rollback_clears_the_connection_instead_of_pairing_new_key_with_old_server() {
    let previous = DestinationSummary {
        server_url: "https://old.example".to_owned(),
        user_id: "old-user".to_owned(),
        display_name: "Previous Destination".to_owned(),
        email: None,
        insecure_http: false,
    };
    let vault_value = Rc::new(RefCell::new(Some("previous-key".to_owned())));
    let vault = RestoreFailingVault {
        value: Rc::clone(&vault_value),
    };
    let settings = SaveFailingSettings(Rc::new(RefCell::new(Some(previous))));
    let service = DestinationService::new(
        FakeKarakeepClient {
            result: Ok(compatible_user()),
            observed_key: RefCell::new(None),
        },
        vault,
        settings,
    );

    let error = service
        .connect(ConnectDestinationInput {
            server: "https://new.example".to_owned(),
            api_key: "new-key".to_owned(),
            allow_insecure_http: false,
        })
        .expect_err("settings persistence and credential rollback fail");

    assert_eq!(error.code(), DestinationErrorCode::Storage);
    assert_eq!(service.status().expect("fail-closed status"), None);
    assert_eq!(*vault_value.borrow(), None);
}

#[derive(Clone)]
struct CleanupFailingVault(Rc<RefCell<Option<String>>>);

impl CredentialVault for CleanupFailingVault {
    fn load(&self) -> Result<Option<String>, DestinationError> {
        Ok(self.0.borrow().clone())
    }

    fn save(&self, api_key: &str) -> Result<(), DestinationError> {
        if api_key == "previous-key" {
            return Err(DestinationError::for_code(DestinationErrorCode::Storage));
        }
        self.0.replace(Some(api_key.to_owned()));
        Ok(())
    }

    fn delete(&self) -> Result<(), DestinationError> {
        Err(DestinationError::for_code(DestinationErrorCode::Storage))
    }
}

#[derive(Clone)]
struct CleanupFailingSettings(Rc<RefCell<Option<DestinationSummary>>>);

impl DestinationSettings for CleanupFailingSettings {
    fn load(&self) -> Result<Option<DestinationSummary>, DestinationError> {
        Ok(self.0.borrow().clone())
    }

    fn save(&self, _destination: &DestinationSummary) -> Result<(), DestinationError> {
        Err(DestinationError::for_code(DestinationErrorCode::Storage))
    }

    fn delete(&self) -> Result<(), DestinationError> {
        Err(DestinationError::for_code(DestinationErrorCode::Storage))
    }
}

#[test]
fn unrecoverable_credential_rollback_poisoning_blocks_status_and_delivery() {
    let previous = DestinationSummary {
        server_url: "https://old.example".to_owned(),
        user_id: "old-user".to_owned(),
        display_name: "Previous Destination".to_owned(),
        email: None,
        insecure_http: false,
    };
    let service = DestinationService::new(
        FakeKarakeepClient {
            result: Ok(compatible_user()),
            observed_key: RefCell::new(None),
        },
        CleanupFailingVault(Rc::new(RefCell::new(Some("previous-key".to_owned())))),
        CleanupFailingSettings(Rc::new(RefCell::new(Some(previous)))),
    );

    let error = service
        .connect(ConnectDestinationInput {
            server: "https://new.example".to_owned(),
            api_key: "new-key".to_owned(),
            allow_insecure_http: false,
        })
        .expect_err("all rollback and cleanup paths fail");

    assert_eq!(error.code(), DestinationErrorCode::Storage);
    assert_eq!(
        service.status().expect("poisoned status is fail-closed"),
        None
    );
    assert_eq!(
        service
            .delivery_api(std::time::Duration::from_secs(20))
            .err()
            .expect("poisoned service blocks delivery")
            .code(),
        DestinationErrorCode::Storage
    );
}

#[test]
fn forgetting_a_destination_removes_both_the_vault_entry_and_ready_state() {
    let client = FakeKarakeepClient {
        result: Ok(compatible_user()),
        observed_key: RefCell::new(None),
    };
    let vault = MemoryVault::default();
    let settings = MemorySettings::default();
    let service = DestinationService::new(client, vault.clone(), settings.clone());
    service
        .connect(ConnectDestinationInput {
            server: "https://keep.example".to_owned(),
            api_key: "temporary-key".to_owned(),
            allow_insecure_http: false,
        })
        .unwrap();

    service.forget().expect("connection can be forgotten");

    assert_eq!(service.status().unwrap(), None);
    assert_eq!(vault.load().unwrap(), None);
    assert_eq!(settings.load().unwrap(), None);
}
