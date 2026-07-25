use std::fs;

use karakeep_transfer_lib::{
    private_data::{DeleteLocalTransferData, ReplaceXSource},
    settings::SettingsService,
};
use tempfile::tempdir;

fn populated_service() -> (tempfile::TempDir, SettingsService) {
    let directory = tempdir().expect("temporary directory");
    let ledger = directory.path().join("delivery-ledger.sqlite3");
    let snapshot = directory.path().join("fieldtheory/bookmarks.jsonl");
    let acquisition = directory.path().join("fieldtheory/acquisition");
    let abandoned_staging = directory.path().join("fieldtheory/.acquisition-crash");
    let second_abandoned_staging = directory
        .path()
        .join("fieldtheory/.acquisition-second-crash");
    fs::create_dir_all(&acquisition).expect("acquisition directory");
    fs::create_dir_all(&abandoned_staging).expect("abandoned acquisition directory");
    fs::create_dir_all(second_abandoned_staging.join("nested"))
        .expect("second abandoned acquisition directory");
    fs::write(&ledger, b"ledger").expect("ledger");
    fs::write(&snapshot, b"snapshot").expect("snapshot");
    fs::write(acquisition.join("cursor"), b"state").expect("acquisition state");
    fs::write(abandoned_staging.join("partial"), b"staging").expect("abandoned data");
    fs::write(
        second_abandoned_staging.join("nested/partial"),
        b"other-staging",
    )
    .expect("second abandoned data");
    fs::write(directory.path().join("fieldtheory/keep.txt"), b"keep")
        .expect("unrelated source-root file");
    fs::create_dir(directory.path().join("fieldtheory/.acquisition"))
        .expect("non-staging directory");
    fs::write(
        directory.path().join("fieldtheory/.acquisition-file"),
        b"not a staging directory",
    )
    .expect("non-staging file");

    let service = SettingsService::from_app_data_dir(directory.path());
    (directory, service)
}

#[test]
fn settings_disclose_location_and_sizes_without_reading_bookmark_content() {
    let (directory, service) = populated_service();

    let summary = service
        .inspect_private_data()
        .expect("private data summary");

    assert_eq!(
        (
            summary.data_directory,
            summary.snapshot_bytes,
            summary.acquisition_state_bytes,
            summary.ledger_bytes,
            summary.total_bytes,
        ),
        (directory.path().display().to_string(), 8, 25, 6, 39,)
    );
}

#[test]
fn replacing_x_source_removes_only_snapshot_and_acquisition_state() {
    let (directory, service) = populated_service();

    service
        .replace_x_source(ReplaceXSource::confirmed())
        .expect("source replacement");

    assert_eq!(
        (
            directory
                .path()
                .join("fieldtheory/bookmarks.jsonl")
                .exists(),
            directory.path().join("fieldtheory/acquisition").exists(),
            directory
                .path()
                .join("fieldtheory/.acquisition-crash")
                .exists(),
            directory
                .path()
                .join("fieldtheory/.acquisition-second-crash")
                .exists(),
            directory.path().join("fieldtheory/keep.txt").exists(),
            directory.path().join("fieldtheory/.acquisition").exists(),
            directory
                .path()
                .join("fieldtheory/.acquisition-file")
                .exists(),
            directory.path().join("delivery-ledger.sqlite3").exists(),
        ),
        (false, false, false, false, true, true, true, true)
    );
}

#[test]
fn confirmed_local_data_deletion_removes_snapshot_state_and_ledger() {
    let (directory, service) = populated_service();

    service
        .delete_local_transfer_data(DeleteLocalTransferData::confirmed())
        .expect("local data deletion");

    assert_eq!(
        (
            directory
                .path()
                .join("fieldtheory/bookmarks.jsonl")
                .exists(),
            directory.path().join("fieldtheory/acquisition").exists(),
            directory
                .path()
                .join("fieldtheory/.acquisition-crash")
                .exists(),
            directory
                .path()
                .join("fieldtheory/.acquisition-second-crash")
                .exists(),
            directory.path().join("fieldtheory/keep.txt").exists(),
            directory.path().join("fieldtheory/.acquisition").exists(),
            directory
                .path()
                .join("fieldtheory/.acquisition-file")
                .exists(),
            directory.path().join("delivery-ledger.sqlite3").exists(),
        ),
        (false, false, false, false, true, true, true, false)
    );
}
