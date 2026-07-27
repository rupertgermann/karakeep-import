use std::fs;

use karakeep_transfer_lib::{
    bookmark::BookmarkPreview,
    fieldtheory::FieldTheoryState,
    file_source::{FileSourceFormat, FileSourcePreview, ResolvedFileSourceFormat},
};
use serde_json::json;

mod fieldtheory {
    pub use karakeep_transfer_lib::fieldtheory::*;
}

mod file_source {
    pub use karakeep_transfer_lib::file_source::*;
}

mod transfer_options {
    pub use karakeep_transfer_lib::transfer_options::*;
}

#[path = "../src/transfer_source.rs"]
mod transfer_source;

use transfer_options::TransferOptions;
use transfer_source::{
    TransferSourceErrorCode, TransferSourceRequest, deduplicated_preview_folders,
    resolve_transfer_source,
};

#[test]
fn transfer_source_request_matches_the_frontend_serde_contract() {
    let x: TransferSourceRequest =
        serde_json::from_value(json!({ "kind": "x" })).expect("X request");
    let file: TransferSourceRequest = serde_json::from_value(json!({
        "kind": "file",
        "path": "/selected/bookmarks.jsonl",
        "format": "fieldTheoryJsonl"
    }))
    .expect("file request");

    assert_eq!(
        serde_json::to_value(x).expect("X serializes"),
        json!({ "kind": "x" })
    );
    assert_eq!(
        serde_json::to_value(file).expect("file serializes"),
        json!({
            "kind": "file",
            "path": "/selected/bookmarks.jsonl",
            "format": "fieldTheoryJsonl"
        })
    );
}

#[test]
fn x_request_resolves_the_private_snapshot_without_exposing_path_or_raw_fields() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let snapshot_root = temporary.path().join("fieldtheory");
    fs::create_dir_all(&snapshot_root).expect("snapshot directory");
    fs::write(
        snapshot_root.join("bookmarks.jsonl"),
        "{\"tweetId\":\"1\",\"url\":\"https://x.com/example/status/1\",\"auth_token\":\"raw-auth-secret\",\"ct0\":\"raw-csrf-secret\"}\n",
    )
    .expect("snapshot");
    fs::create_dir_all(snapshot_root.join("acquisition")).expect("acquisition state directory");
    fs::write(snapshot_root.join("acquisition/source.json"), "{}\n").expect("source binding");
    let state = FieldTheoryState::bundled(temporary.path(), temporary.path());

    let preview = resolve_transfer_source(
        &TransferSourceRequest::X,
        &state,
        &TransferOptions::default(),
    )
    .expect("resolved X snapshot");
    let serialized = serde_json::to_string(&preview).expect("preview serializes");

    assert_eq!(preview.bookmarks[0].source_id, "1");
    assert!(!serialized.contains(&temporary.path().display().to_string()));
    assert!(!serialized.contains("raw-auth-secret"));
    assert!(!serialized.contains("raw-csrf-secret"));
}

#[test]
fn file_request_revalidates_a_regular_file_and_uses_the_requested_format() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let selected = temporary.path().join("bookmarks.data");
    let contents = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://example.com/article">Article</A>
</DL><p>"#;
    fs::write(&selected, contents).expect("selected file");
    let state = FieldTheoryState::bundled(temporary.path(), temporary.path());
    let request = TransferSourceRequest::File {
        path: selected.clone(),
        format: FileSourceFormat::ChromeNetscape,
    };

    let preview = resolve_transfer_source(&request, &state, &TransferOptions::default())
        .expect("resolved file");

    assert_eq!(preview.format, ResolvedFileSourceFormat::ChromeNetscape);
    assert_eq!(preview.bookmarks[0].url, "https://example.com/article");
    assert_eq!(
        fs::read_to_string(selected).expect("source remains in place"),
        contents
    );
}

#[test]
fn non_file_and_unreadable_sources_have_fixed_redacted_errors() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let state = FieldTheoryState::bundled(temporary.path(), temporary.path());
    let selected_directory = temporary.path().join("private-bookmarks");
    fs::create_dir(&selected_directory).expect("selected directory");

    let non_file = resolve_transfer_source(
        &TransferSourceRequest::File {
            path: selected_directory.clone(),
            format: FileSourceFormat::Auto,
        },
        &state,
        &TransferOptions::default(),
    )
    .expect_err("directories are not File Sources");
    let missing_path = temporary.path().join("missing-secret-name.jsonl");
    let missing = resolve_transfer_source(
        &TransferSourceRequest::File {
            path: missing_path.clone(),
            format: FileSourceFormat::Auto,
        },
        &state,
        &TransferOptions::default(),
    )
    .expect_err("missing file fails");

    for error in [non_file, missing] {
        let serialized = serde_json::to_string(&error).expect("error serializes");
        assert_eq!(error.code(), TransferSourceErrorCode::FileUnreadable);
        assert_eq!(error.to_string(), "The selected file could not be read.");
        assert_eq!(
            serde_json::to_value(&error).expect("typed error"),
            json!({
                "code": "fileUnreadable",
                "message": "The selected file could not be read."
            })
        );
        assert!(!serialized.contains(&temporary.path().display().to_string()));
        assert!(!serialized.contains("private-bookmarks"));
        assert!(!serialized.contains("missing-secret-name"));
    }
}

#[test]
fn invalid_file_and_missing_x_snapshot_errors_hide_parser_and_storage_details() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let state = FieldTheoryState::bundled(temporary.path(), temporary.path());
    let invalid_path = temporary.path().join("private-invalid.jsonl");
    let private_bookmark_text = "private bookmark text";
    fs::write(&invalid_path, private_bookmark_text).expect("invalid selected file");

    let invalid = resolve_transfer_source(
        &TransferSourceRequest::File {
            path: invalid_path,
            format: FileSourceFormat::FieldTheoryJsonl,
        },
        &state,
        &TransferOptions::default(),
    )
    .expect_err("invalid source fails");
    let missing_x = resolve_transfer_source(
        &TransferSourceRequest::X,
        &state,
        &TransferOptions::default(),
    )
    .expect_err("missing X snapshot fails");

    assert_eq!(invalid.code(), TransferSourceErrorCode::InvalidFileSource);
    assert_eq!(
        invalid.to_string(),
        "The selected file is not a valid supported File Source."
    );
    assert_eq!(
        missing_x.code(),
        TransferSourceErrorCode::XSourceUnavailable
    );
    assert_eq!(missing_x.to_string(), "The active X Source is unavailable.");
    assert_eq!(
        serde_json::to_value(&invalid).expect("typed invalid-file error"),
        json!({
            "code": "invalidFileSource",
            "message": "The selected file is not a valid supported File Source."
        })
    );
    assert_eq!(
        serde_json::to_value(&missing_x).expect("typed X error"),
        json!({
            "code": "xSourceUnavailable",
            "message": "The active X Source is unavailable."
        })
    );
    let serialized = serde_json::to_string(&(invalid, missing_x)).expect("errors serialize");
    assert!(!serialized.contains(&temporary.path().display().to_string()));
    assert!(!serialized.contains(private_bookmark_text));
    assert!(!serialized.contains("line 1"));
}

#[test]
fn preview_folders_are_deduplicated_case_insensitively_in_first_seen_order() {
    let preview = FileSourcePreview {
        format: ResolvedFileSourceFormat::FieldTheoryJsonl,
        bookmarks: vec![
            bookmark("one", &["Research", "Reading"]),
            bookmark("two", &["research", "Archive", "READING"]),
        ],
    };

    assert_eq!(
        deduplicated_preview_folders(&preview),
        ["Research", "Reading", "Archive"]
    );
}

fn bookmark(source_id: &str, folders: &[&str]) -> BookmarkPreview {
    BookmarkPreview {
        source_id: source_id.into(),
        url: format!("https://example.com/{source_id}"),
        title: String::new(),
        note: String::new(),
        created_at: None,
        tags: Vec::new(),
        folders: folders.iter().map(|folder| (*folder).to_owned()).collect(),
    }
}
