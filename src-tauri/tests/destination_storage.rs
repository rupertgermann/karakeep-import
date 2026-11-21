use karakeep_transfer_lib::destination::{
    DestinationSettings, DestinationSummary, FileDestinationSettings, NativeCredentialVault,
};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn temporary_settings_path() -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir()
        .join(format!(
            "karakeep-transfer-destination-{}-{unique}",
            std::process::id()
        ))
        .join("destination.json")
}

#[test]
fn destination_settings_round_trip_contains_identity_but_no_credential() {
    let path = temporary_settings_path();
    let settings = FileDestinationSettings::new(path.clone());
    let destination = DestinationSummary {
        server_url: "https://keep.example".to_owned(),
        user_id: "user-1".to_owned(),
        display_name: "Ada Example".to_owned(),
        email: Some("ada@example.com".to_owned()),
        insecure_http: false,
    };

    settings.save(&destination).expect("settings save");

    assert_eq!(settings.load().unwrap(), Some(destination));
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("https://keep.example"));
    assert!(contents.contains("user-1"));
    assert!(!contents.contains("apiKey"));
    assert!(!contents.contains("credential"));
    assert!(!contents.contains("secret"));

    settings.delete().expect("settings delete");
    assert_eq!(settings.load().unwrap(), None);
}

#[test]
fn native_vault_is_a_thread_safe_operating_system_boundary() {
    fn assert_send_sync<T: Send + Sync>() {}

    assert_send_sync::<NativeCredentialVault>();
}
