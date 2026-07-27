use std::{
    num::NonZeroUsize,
    sync::{Arc, Mutex},
};

use karakeep_transfer_lib::{
    bookmark::BookmarkPreview,
    domain::{DeliveryAttempt, DeliveryOutcome, DestinationIdentity, TimestampMillis},
    file_source::{FileSourceFormat, FileSourcePreview, ResolvedFileSourceFormat, preview_text},
    ledger::DeliveryLedger,
    preferences::{DeliveryTuning, PreferencesError, PreferencesStore, TransferPreferences},
    transfer::preview_delivery_counts,
    transfer_options::{SourceDefaultTags, TimestampField, TransferOptions},
};

const FIELD_THEORY: &str = r#"{"tweetId":"1","url":"https://x.com/example/status/1","text":"A post","postedAt":"2023-10-11T14:08:46Z","bookmarkedAt":"2024-03-04T05:06:07Z","tags":["Reading","fieldtheory","reading"],"folderNames":["Research"]}"#;

const CHROME: &str = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Research</H3>
  <DL><p>
    <DT><A HREF="https://example.com/article" ADD_DATE="1721779200">Article</A>
  </DL><p>
</DL><p>"#;

fn field_theory(options: &TransferOptions) -> BookmarkPreview {
    preview_text(
        "bookmarks.jsonl",
        FIELD_THEORY,
        FileSourceFormat::FieldTheoryJsonl,
        options,
    )
    .expect("Field Theory preview")
    .bookmarks
    .remove(0)
}

fn chrome(options: &TransferOptions) -> BookmarkPreview {
    preview_text(
        "bookmarks.html",
        CHROME,
        FileSourceFormat::ChromeNetscape,
        options,
    )
    .expect("Chrome preview")
    .bookmarks
    .remove(0)
}

fn with_all_default_tags() -> SourceDefaultTags {
    SourceDefaultTags {
        twitter: true,
        field_theory: true,
        chrome: true,
    }
}

#[test]
fn no_source_default_tag_is_attached_until_one_is_selected() {
    assert_eq!(SourceDefaultTags::default(), SourceDefaultTags::NONE);
    assert_eq!(
        field_theory(&TransferOptions::default()).tags,
        ["Reading", "Research"]
    );
    assert_eq!(chrome(&TransferOptions::default()).tags, ["Research"]);
}

#[test]
fn selected_source_default_tags_lead_the_tag_list_for_their_own_format() {
    let options = TransferOptions {
        default_tags: with_all_default_tags(),
        ..TransferOptions::default()
    };

    assert_eq!(
        field_theory(&options).tags,
        ["twitter", "fieldtheory", "Reading", "Research"]
    );
    assert_eq!(chrome(&options).tags, ["chrome", "Research"]);
}

#[test]
fn an_export_carried_fieldtheory_tag_appears_only_when_it_is_selected() {
    let unselected = TransferOptions {
        default_tags: SourceDefaultTags {
            twitter: true,
            ..SourceDefaultTags::NONE
        },
        ..TransferOptions::default()
    };

    assert_eq!(
        field_theory(&unselected).tags,
        ["twitter", "Reading", "Research"]
    );
    assert!(
        field_theory(&TransferOptions {
            default_tags: with_all_default_tags(),
            ..TransferOptions::default()
        })
        .tags
        .contains(&"fieldtheory".to_string())
    );
}

#[test]
fn extra_tags_are_attached_to_every_record_and_normalized() {
    let options = TransferOptions {
        extra_tags: vec![
            "  Imported  ".into(),
            "   ".into(),
            String::new(),
            "imported".into(),
        ],
        default_tags: with_all_default_tags(),
        ..TransferOptions::default()
    };

    assert_eq!(
        field_theory(&options).tags,
        ["twitter", "fieldtheory", "Imported", "Reading", "Research"]
    );
    assert_eq!(chrome(&options).tags, ["chrome", "Imported", "Research"]);
}

#[test]
fn the_three_tag_groups_are_independent() {
    let base = TransferOptions {
        extra_tags: vec!["Imported".into()],
        default_tags: with_all_default_tags(),
        ..TransferOptions::default()
    };

    let without_defaults = TransferOptions {
        include_default_tags: false,
        ..base.clone()
    };
    let without_export = TransferOptions {
        include_export_tags: false,
        ..base.clone()
    };

    assert_eq!(
        field_theory(&without_defaults).tags,
        ["Imported", "Reading", "Research"]
    );
    assert_eq!(
        field_theory(&without_export).tags,
        ["twitter", "fieldtheory", "Imported"]
    );
    assert_eq!(chrome(&without_export).tags, ["chrome", "Imported"]);
}

#[test]
fn suppressed_export_tags_also_empty_the_preview_folder_summary() {
    let options = TransferOptions {
        include_export_tags: false,
        default_tags: with_all_default_tags(),
        ..TransferOptions::default()
    };

    assert!(field_theory(&options).folders.is_empty());
    assert!(chrome(&options).folders.is_empty());
}

#[test]
fn suppressing_every_tag_group_delivers_a_bookmark_without_tags() {
    let options = TransferOptions {
        include_default_tags: false,
        include_export_tags: false,
        default_tags: with_all_default_tags(),
        ..TransferOptions::default()
    };

    assert!(field_theory(&options).tags.is_empty());
    assert!(chrome(&options).tags.is_empty());
}

#[test]
fn titles_and_notes_can_be_omitted_independently_for_both_formats() {
    let without_titles = TransferOptions {
        include_titles: false,
        ..TransferOptions::default()
    };
    let without_notes = TransferOptions {
        include_notes: false,
        ..TransferOptions::default()
    };

    let field_theory_without_titles = field_theory(&without_titles);
    let chrome_without_notes = chrome(&without_notes);

    assert!(field_theory_without_titles.title.is_empty());
    assert!(!field_theory_without_titles.note.is_empty());
    assert!(field_theory(&without_notes).note.is_empty());
    assert!(chrome(&without_titles).title.is_empty());
    assert!(chrome_without_notes.note.is_empty());
    assert!(!chrome_without_notes.title.is_empty());
}

#[test]
fn omitted_titles_and_notes_reach_delivery_as_absent_fields() {
    let options = TransferOptions {
        include_titles: false,
        include_notes: false,
        ..TransferOptions::default()
    };
    let preview = FileSourcePreview {
        format: ResolvedFileSourceFormat::FieldTheoryJsonl,
        bookmarks: vec![field_theory(&options)],
    };

    let records = karakeep_transfer_lib::delivery::DeliverySource::records(
        &karakeep_transfer_lib::transfer::FileDeliverySource::from_preview(&preview),
    )
    .expect("delivery records");

    assert_eq!(records[0].bookmark.title, None);
    assert_eq!(records[0].bookmark.note, None);
}

#[test]
fn the_timestamp_field_selects_the_source_value_that_becomes_created_at() {
    let created_at = |field| {
        field_theory(&TransferOptions {
            timestamp_field: field,
            ..TransferOptions::default()
        })
        .created_at
    };

    assert_eq!(
        created_at(TimestampField::Source).as_deref(),
        Some("2023-10-11T14:08:46Z")
    );
    assert_eq!(
        created_at(TimestampField::PostedAt).as_deref(),
        Some("2023-10-11T14:08:46Z")
    );
    assert_eq!(
        created_at(TimestampField::BookmarkedAt).as_deref(),
        Some("2024-03-04T05:06:07Z")
    );
    assert_eq!(created_at(TimestampField::None), None);
}

#[test]
fn a_missing_or_unparseable_timestamp_omits_created_at_without_failing_the_record() {
    let record =
        r#"{"tweetId":"2","url":"https://x.com/example/status/2","postedAt":"not a date"}"#;

    let missing = preview_text(
        "bookmarks.jsonl",
        record,
        FileSourceFormat::FieldTheoryJsonl,
        &TransferOptions {
            timestamp_field: TimestampField::AddedAt,
            ..TransferOptions::default()
        },
    )
    .expect("absent field is not an error");
    let unparseable = preview_text(
        "bookmarks.jsonl",
        record,
        FileSourceFormat::FieldTheoryJsonl,
        &TransferOptions::default(),
    )
    .expect("unparseable value is not an error");

    assert_eq!(missing.bookmarks[0].created_at, None);
    assert_eq!(unparseable.bookmarks[0].created_at, None);
}

#[test]
fn chrome_resolves_source_and_added_at_to_its_add_date_and_nothing_else() {
    let created_at = |field| {
        chrome(&TransferOptions {
            timestamp_field: field,
            ..TransferOptions::default()
        })
        .created_at
    };

    assert_eq!(
        created_at(TimestampField::Source).as_deref(),
        Some("2024-07-24T00:00:00Z")
    );
    assert_eq!(
        created_at(TimestampField::AddedAt).as_deref(),
        Some("2024-07-24T00:00:00Z")
    );
    assert_eq!(created_at(TimestampField::PostedAt), None);
    assert_eq!(created_at(TimestampField::BookmarkedAt), None);
    assert_eq!(created_at(TimestampField::None), None);
}

fn ledger_with_one_delivered_record() -> (Arc<Mutex<DeliveryLedger>>, DestinationIdentity) {
    let shared = Arc::new(Mutex::new(
        DeliveryLedger::open_in_memory().expect("ledger opens"),
    ));
    let destination =
        DestinationIdentity::new("https://keep.example", "user-a").expect("destination");
    {
        let mut ledger = shared.lock().expect("ledger lock");
        let run = ledger
            .start_run(&destination, TimestampMillis(1))
            .expect("run starts");
        ledger
            .record_attempt(
                run,
                &karakeep_transfer_lib::domain::BookmarkKey::new("x", "delivered")
                    .expect("bookmark key"),
                DeliveryAttempt::Delivered {
                    karakeep_bookmark_id: "karakeep-1".into(),
                    outcome: DeliveryOutcome::Created,
                },
                TimestampMillis(2),
            )
            .expect("delivery recorded");
    }
    (shared, destination)
}

fn preview_of(ids: &[&str], timestamps: bool) -> FileSourcePreview {
    FileSourcePreview {
        format: ResolvedFileSourceFormat::FieldTheoryJsonl,
        bookmarks: ids
            .iter()
            .map(|id| BookmarkPreview {
                source_id: (*id).into(),
                url: format!("https://x.com/example/status/{id}"),
                title: "Title".into(),
                note: "Note".into(),
                created_at: timestamps.then(|| "2024-01-02T03:04:05Z".to_string()),
                tags: Vec::new(),
                folders: Vec::new(),
            })
            .collect(),
    }
}

#[test]
fn the_previewed_pending_count_applies_the_limit_after_skipping_delivered_records() {
    let (ledger, destination) = ledger_with_one_delivered_record();
    let preview = preview_of(&["delivered", "first", "second", "third"], false);

    let counts = preview_delivery_counts(&preview, &ledger, &destination, Some(2))
        .expect("limited preview counts");
    let uncapped = preview_delivery_counts(&preview, &ledger, &destination, None)
        .expect("uncapped preview counts");

    assert_eq!(
        (counts.total, counts.pending, counts.previously_delivered),
        (4, 2, 1)
    );
    assert_eq!(uncapped.pending, 3);
}

#[test]
fn the_preview_reports_how_many_capped_pending_records_carry_a_timestamp() {
    let (ledger, destination) = ledger_with_one_delivered_record();

    let with_timestamps = preview_delivery_counts(
        &preview_of(&["a", "b", "c"], true),
        &ledger,
        &destination,
        Some(2),
    )
    .expect("preview counts");
    let without_timestamps = preview_delivery_counts(
        &preview_of(&["a", "b", "c"], false),
        &ledger,
        &destination,
        None,
    )
    .expect("preview counts");

    assert_eq!(with_timestamps.preserved_timestamps, 2);
    assert_eq!(without_timestamps.preserved_timestamps, 0);
}

#[test]
fn a_limit_of_zero_is_rejected_at_the_command_boundary() {
    let rejected =
        serde_json::from_str::<TransferOptions>(r#"{"limit":0}"#).expect_err("zero is rejected");
    let accepted: TransferOptions =
        serde_json::from_str(r#"{"limit":10}"#).expect("a positive limit is accepted");

    assert!(rejected.to_string().contains("zero"));
    assert_eq!(accepted.limit, NonZeroUsize::new(10));
}

#[test]
fn the_frontend_cannot_choose_the_settings_owned_default_tags() {
    let options: TransferOptions = serde_json::from_str(
        r#"{"defaultTags":{"twitter":true,"fieldTheory":true,"chrome":true}}"#,
    )
    .expect("options deserialize");

    assert_eq!(options.default_tags, SourceDefaultTags::NONE);
    assert_eq!(
        options
            .with_default_tags(with_all_default_tags())
            .default_tags,
        with_all_default_tags()
    );
}

#[test]
fn preferences_default_to_todays_delivery_behavior_and_no_default_tags() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = PreferencesStore::new(directory.path().join("preferences.json"));

    let preferences = store.load().expect("missing preferences load as defaults");

    assert_eq!(preferences, TransferPreferences::default());
    assert_eq!(preferences.default_tags, SourceDefaultTags::NONE);
    assert_eq!(
        preferences.delivery_tuning,
        DeliveryTuning {
            workers: 4,
            requests_per_second: 4.0,
            timeout_seconds: 20,
            max_retries: 5,
        }
    );
    let config = preferences.delivery_tuning.delivery_config();
    assert_eq!(config.max_concurrency, 4);
    assert_eq!(config.requests_per_second, 4.0);
    assert_eq!(config.retry.max_retries, 5);
    assert_eq!(config.pending_limit, None);
    assert_eq!(
        preferences.delivery_tuning.request_timeout(),
        std::time::Duration::from_secs(20)
    );
}

#[test]
fn saved_preferences_survive_a_restart() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("preferences.json");
    let chosen = TransferPreferences {
        default_tags: with_all_default_tags(),
        delivery_tuning: DeliveryTuning {
            workers: 2,
            requests_per_second: 1.5,
            timeout_seconds: 30,
            max_retries: 0,
        },
    };

    PreferencesStore::new(&path)
        .save(chosen)
        .expect("preferences save");
    let reopened = PreferencesStore::new(&path)
        .load()
        .expect("preferences reload");

    assert_eq!(reopened, chosen);
}

#[test]
fn out_of_range_tuning_is_rejected_and_leaves_the_stored_values_alone() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let store = PreferencesStore::new(directory.path().join("preferences.json"));
    let invalid = [
        DeliveryTuning {
            workers: 0,
            ..DeliveryTuning::default()
        },
        DeliveryTuning {
            requests_per_second: 0.0,
            ..DeliveryTuning::default()
        },
        DeliveryTuning {
            requests_per_second: f64::NAN,
            ..DeliveryTuning::default()
        },
        DeliveryTuning {
            timeout_seconds: 0,
            ..DeliveryTuning::default()
        },
    ];

    for delivery_tuning in invalid {
        assert_eq!(
            store.save(TransferPreferences {
                delivery_tuning,
                ..TransferPreferences::default()
            }),
            Err(PreferencesError::OutOfRange)
        );
    }
    store
        .save(TransferPreferences {
            delivery_tuning: DeliveryTuning {
                max_retries: 0,
                ..DeliveryTuning::default()
            },
            ..TransferPreferences::default()
        })
        .expect("zero retries is in range");
    assert_eq!(store.load().expect("stored").delivery_tuning.max_retries, 0);
}
