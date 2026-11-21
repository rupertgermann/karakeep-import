use std::fs;

use karakeep_transfer_lib::{
    file_source::{
        FileSourceError, FileSourceFormat, FileSourcePosition, ResolvedFileSourceFormat,
        preview_file, preview_text,
    },
    transfer_options::{SourceDefaultTags, TransferOptions},
};

/// The source marker tags a person selects in Settings. These tests assert the
/// mapping that results once they are selected; no marker tag is attached by
/// default.
fn source_tag_options() -> TransferOptions {
    TransferOptions {
        default_tags: SourceDefaultTags {
            twitter: true,
            field_theory: false,
            chrome: true,
        },
        ..TransferOptions::default()
    }
}

const FIELD_THEORY_ONE: &str = include_str!("fixtures/field-theory-one.jsonl");
const FIELD_THEORY_MANY: &str = include_str!("fixtures/field-theory-many.jsonl");
const CHROME_BOOKMARKS: &str = include_str!("fixtures/chrome-bookmarks.html");
const CHROME_AMBIGUOUS: &str = include_str!("fixtures/chrome-ambiguous.txt");

#[test]
fn one_field_theory_record_maps_to_a_read_only_transfer_preview() {
    let preview = preview_text(
        "bookmarks.jsonl",
        FIELD_THEORY_ONE,
        FileSourceFormat::Auto,
        &source_tag_options(),
    )
    .expect("valid Field Theory preview");

    assert_eq!(preview.format, ResolvedFileSourceFormat::FieldTheoryJsonl);
    assert_eq!(preview.bookmarks.len(), 1);

    let bookmark = &preview.bookmarks[0];
    assert_eq!(bookmark.source_id, "123");
    assert_eq!(bookmark.url, "https://x.com/example/status/123");
    assert_eq!(
        bookmark.title,
        "Example Person (@example): A useful post with details."
    );
    assert_eq!(bookmark.created_at.as_deref(), Some("2023-10-11T14:08:46Z"));
    assert_eq!(bookmark.tags, ["twitter", "Reading"]);
    assert_eq!(bookmark.folders, ["Reading"]);
    assert!(bookmark.note.contains("A useful post\nwith details."));
    assert!(bookmark.note.contains("Author: Example Person (@example)"));
    assert!(bookmark.note.contains("Posted: 2023-10-11T14:08:46Z"));
    assert!(bookmark.note.contains("Tweet ID: 123"));
    assert!(
        bookmark
            .note
            .contains("Linked URLs: https://example.com/article")
    );
    assert!(
        bookmark
            .note
            .contains("> Quoted from Quoted Person (@quoted):\n> Quoted context\n> on two lines.")
    );
    assert!(bookmark.note.ends_with("Transferred from Field Theory."));
}

#[test]
fn multiple_field_theory_records_are_previewed_in_file_order() {
    let preview = preview_text(
        "bookmarks.jsonl",
        FIELD_THEORY_MANY,
        FileSourceFormat::Auto,
        &source_tag_options(),
    )
    .expect("valid multi-record Field Theory preview");

    assert_eq!(preview.bookmarks.len(), 2);
    assert_eq!(preview.bookmarks[0].source_id, "123");
    assert_eq!(preview.bookmarks[1].source_id, "456");
    assert_eq!(preview.bookmarks[1].title, "An explicit title");
    assert_eq!(
        preview.bookmarks[1].created_at.as_deref(),
        Some("2024-01-02T03:04:05Z")
    );
}

#[test]
fn field_theory_folder_names_from_x_acquisition_become_folder_tags() {
    let input = r#"{"id":"folder-record","url":"https://x.com/example/status/9","folderNames":["Research","research"],"tags":["fieldtheory"]}"#;

    let preview = preview_text(
        "bookmarks.jsonl",
        input,
        FileSourceFormat::FieldTheoryJsonl,
        &source_tag_options(),
    )
    .expect("valid acquired Field Theory snapshot");

    assert_eq!(
        (
            preview.bookmarks[0].folders.clone(),
            preview.bookmarks[0].tags.clone(),
        ),
        (
            vec!["Research".to_string()],
            vec!["twitter".to_string(), "Research".to_string()],
        )
    );
}

#[test]
fn chrome_netscape_header_is_auto_detected_and_mapped() {
    let preview = preview_text(
        "bookmarks-export",
        CHROME_BOOKMARKS,
        FileSourceFormat::Auto,
        &source_tag_options(),
    )
    .expect("valid Chrome preview");

    assert_eq!(preview.format, ResolvedFileSourceFormat::ChromeNetscape);
    assert_eq!(preview.bookmarks.len(), 1);

    let bookmark = &preview.bookmarks[0];
    assert_eq!(bookmark.source_id, "https://example.com/docs?a=1&b=2");
    assert_eq!(bookmark.url, "https://example.com/docs?a=1&b=2");
    assert_eq!(bookmark.title, "Example & Documentation");
    assert_eq!(bookmark.created_at.as_deref(), Some("2024-07-24T00:00:00Z"));
    assert_eq!(bookmark.folders, ["Bookmarks bar", "Research & Docs"]);
    assert_eq!(
        bookmark.tags,
        ["chrome", "Bookmarks bar", "Research & Docs"]
    );
    assert_eq!(
        bookmark.note,
        "Chrome folder: Bookmarks bar > Research & Docs\n\
         Added to Chrome: 2024-07-24T00:00:00Z\n\
         Transferred from Chrome bookmarks."
    );
}

#[test]
fn ambiguous_chrome_content_can_be_selected_explicitly() {
    let preview = preview_text(
        "bookmarks-export.txt",
        CHROME_AMBIGUOUS,
        FileSourceFormat::ChromeNetscape,
        &source_tag_options(),
    )
    .expect("explicit Chrome fallback");

    assert_eq!(preview.format, ResolvedFileSourceFormat::ChromeNetscape);
    assert_eq!(preview.bookmarks[0].title, "Reference");
    assert_eq!(preview.bookmarks[0].folders, ["Reference"]);
}

#[test]
fn chrome_folder_path_is_preserved_while_human_tags_are_deduplicated() {
    let input = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Research</H3>
  <DL><p>
    <DT><H3>research</H3>
    <DL><p>
      <DT><A HREF="https://example.com/research">Research</A>
    </DL><p>
    <DT><A HREF="https://example.com/overview">Overview</A>
  </DL><p>
</DL><p>"#;

    let preview = preview_text(
        "bookmarks.html",
        input,
        FileSourceFormat::ChromeNetscape,
        &source_tag_options(),
    )
    .expect("valid nested Chrome folders");
    let bookmark = &preview.bookmarks[0];

    assert_eq!(bookmark.folders, ["Research", "research"]);
    assert_eq!(bookmark.tags, ["chrome", "Research"]);
    assert!(bookmark.note.contains("Chrome folder: Research > research"));
    assert_eq!(preview.bookmarks[1].folders, ["Research"]);
}

#[test]
fn chrome_notes_keep_the_folder_path_when_export_tags_are_disabled() {
    let mut options = TransferOptions {
        include_export_tags: false,
        ..source_tag_options()
    };
    let preview = preview_text(
        "bookmarks.html",
        CHROME_BOOKMARKS,
        FileSourceFormat::ChromeNetscape,
        &options,
    )
    .expect("valid Chrome preview");
    let bookmark = &preview.bookmarks[0];
    assert_eq!(bookmark.tags, ["chrome"]);
    assert!(
        bookmark
            .note
            .contains("Chrome folder: Bookmarks bar > Research & Docs")
    );

    options.include_notes = false;
    let preview = preview_text(
        "bookmarks.html",
        CHROME_BOOKMARKS,
        FileSourceFormat::ChromeNetscape,
        &options,
    )
    .expect("valid Chrome preview without notes");
    assert!(preview.bookmarks[0].note.is_empty());
}

#[test]
fn field_theory_skips_blank_identifier_candidates() {
    let input = concat!(
        r#"{"tweetId":"   ","id":" 42 ","url":"https://example.com/one"}"#,
        "\n",
        r#"{"tweetId":"","id":" ","url":"https://example.com/two"}"#,
    );
    let preview = preview_text(
        "bookmarks.jsonl",
        input,
        FileSourceFormat::FieldTheoryJsonl,
        &source_tag_options(),
    )
    .expect("records with valid identifier fallbacks");

    assert_eq!(preview.bookmarks[0].source_id, "42");
    assert!(preview.bookmarks[0].note.contains("Tweet ID: 42"));
    assert_eq!(preview.bookmarks[1].source_id, "https://example.com/two");
    assert!(
        preview_text(
            "bookmarks.jsonl",
            r#"{"tweetId":"","id":" ","url":" "}"#,
            FileSourceFormat::FieldTheoryJsonl,
            &source_tag_options(),
        )
        .is_err()
    );
}

#[test]
fn field_theory_duplicate_source_ids_are_rejected() {
    let duplicate_id = concat!(
        "{\"id\":\"same\",\"url\":\"https://example.com/one\"}\n",
        "{\"id\":\"same\",\"url\":\"https://example.com/two\"}\n"
    );
    let error = preview_text(
        "bookmarks.jsonl",
        duplicate_id,
        FileSourceFormat::FieldTheoryJsonl,
        &source_tag_options(),
    )
    .expect_err("duplicate source ID must fail");
    assert_eq!(
        error,
        FileSourceError::DuplicateSourceId {
            position: FileSourcePosition::Line(2)
        }
    );
}

#[test]
fn field_theory_duplicate_urls_are_rejected() {
    let duplicate_url = concat!(
        "{\"id\":\"one\",\"url\":\"https://example.com/same\"}\n",
        "{\"id\":\"two\",\"url\":\"https://example.com/same\"}\n"
    );
    let error = preview_text(
        "bookmarks.jsonl",
        duplicate_url,
        FileSourceFormat::FieldTheoryJsonl,
        &source_tag_options(),
    )
    .expect_err("duplicate URL must fail");
    assert_eq!(
        error,
        FileSourceError::DuplicateUrl {
            position: FileSourcePosition::Line(2)
        }
    );
}

#[test]
fn chrome_duplicates_are_rejected_after_view_source_normalization() {
    let input = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://example.com/docs">Documentation</A>
  <DT><A HREF="view-source:https://example.com/docs">Source</A>
</DL><p>"#;

    let error = preview_text(
        "bookmarks.html",
        input,
        FileSourceFormat::ChromeNetscape,
        &source_tag_options(),
    )
    .expect_err("normalized duplicate must fail");

    assert_eq!(
        error,
        FileSourceError::DuplicateUrl {
            position: FileSourcePosition::Bookmark(2)
        }
    );
}

#[test]
fn chrome_accepts_unquoted_url_paths_and_keeps_the_anchor_text() {
    let input = "<DL><p>\n\
        <DT><A HREF=https://example.com/docs/>Documentation</A>\n\
        <DT><A HREF=https://example.com/reference/start ADD_DATE=1721779200>Reference</A>\n\
        </DL><p>";
    let preview = preview_text(
        "bookmarks.html",
        input,
        FileSourceFormat::ChromeNetscape,
        &source_tag_options(),
    )
    .expect("valid unquoted Chrome links");

    assert_eq!(preview.bookmarks[0].url, "https://example.com/docs/");
    assert_eq!(preview.bookmarks[0].title, "Documentation");
    assert_eq!(
        preview.bookmarks[1].url,
        "https://example.com/reference/start"
    );
    assert_eq!(
        preview.bookmarks[1].created_at.as_deref(),
        Some("2024-07-24T00:00:00Z")
    );
}

#[test]
fn invalid_json_objects_are_rejected() {
    let error = preview_text(
        "bookmarks.jsonl",
        "[]\n",
        FileSourceFormat::FieldTheoryJsonl,
        &source_tag_options(),
    )
    .expect_err("non-object JSONL value must fail");
    assert_eq!(
        error,
        FileSourceError::InvalidRecord {
            position: FileSourcePosition::Line(1)
        }
    );
}

#[test]
fn non_web_chrome_urls_are_rejected() {
    let error = preview_text(
        "bookmarks.html",
        r#"<DL><p><DT><A HREF="javascript:alert(1)">Bookmarklet</A></DL><p>"#,
        FileSourceFormat::ChromeNetscape,
        &source_tag_options(),
    )
    .expect_err("bookmarklet must fail");
    assert_eq!(
        error,
        FileSourceError::InvalidUrl {
            position: FileSourcePosition::Bookmark(1)
        }
    );
}

#[test]
fn preview_file_reads_the_selected_file_in_place_without_copying_it() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let selected = temporary.path().join("bookmarks.jsonl");
    fs::write(&selected, FIELD_THEORY_ONE).expect("fixture file");

    let before = fs::read_dir(temporary.path())
        .expect("directory is readable")
        .count();
    let preview = preview_file(&selected, FileSourceFormat::Auto, &source_tag_options())
        .expect("preview selected file");
    let after = fs::read_dir(temporary.path())
        .expect("directory remains readable")
        .count();

    assert_eq!(preview.bookmarks.len(), 1);
    assert_eq!(before, 1);
    assert_eq!(after, 1);
    assert_eq!(
        fs::read_to_string(&selected).expect("source remains intact"),
        FIELD_THEORY_ONE
    );
}
