use std::num::NonZeroUsize;

use serde::{Deserialize, Serialize};

/// The source field that becomes Karakeep's `createdAt`.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TimestampField {
    /// The field the source itself considers its creation time.
    #[default]
    Source,
    PostedAt,
    BookmarkedAt,
    AddedAt,
    /// Omit `createdAt` so Karakeep applies its own creation time.
    None,
}

/// The source marker tags a transfer may attach. Which of them a transfer
/// attaches is a Settings preference rather than a per-run choice, so this
/// value is filled in by the backend and never accepted from the frontend.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDefaultTags {
    pub twitter: bool,
    pub field_theory: bool,
    pub chrome: bool,
}

impl SourceDefaultTags {
    pub const NONE: Self = Self {
        twitter: false,
        field_theory: false,
        chrome: false,
    };

    pub const FIELD_THEORY_TAG: &'static str = "fieldtheory";

    pub(crate) fn field_theory_tags(self) -> Vec<String> {
        let mut tags = Vec::new();
        if self.twitter {
            tags.push("twitter".to_string());
        }
        if self.field_theory {
            tags.push(Self::FIELD_THEORY_TAG.to_string());
        }
        tags
    }

    pub(crate) fn chrome_tags(self) -> Vec<String> {
        if self.chrome {
            vec!["chrome".to_string()]
        } else {
            Vec::new()
        }
    }
}

/// No source marker tag is attached until a person selects one in Settings,
/// as recorded in ADR 0026.
impl Default for SourceDefaultTags {
    fn default() -> Self {
        Self::NONE
    }
}

/// The source mapping choices for one transfer run.
///
/// The preview a person approves is the snapshot delivery replays, so these
/// options are bound to that approval: changing one re-previews the transfer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferOptions {
    /// Extra static tags attached to every record in the run.
    pub extra_tags: Vec<String>,
    /// Attach the source marker tags selected in Settings.
    pub include_default_tags: bool,
    /// Attach the tags the export carries: Field Theory `tags` values and
    /// Chrome folder names.
    pub include_export_tags: bool,
    pub include_titles: bool,
    pub include_notes: bool,
    pub timestamp_field: TimestampField,
    /// Cap the run at the first N pending records.
    pub limit: Option<NonZeroUsize>,
    #[serde(skip_deserializing)]
    pub default_tags: SourceDefaultTags,
}

impl Default for TransferOptions {
    fn default() -> Self {
        Self {
            extra_tags: Vec::new(),
            include_default_tags: true,
            include_export_tags: true,
            include_titles: true,
            include_notes: true,
            timestamp_field: TimestampField::default(),
            limit: None,
            default_tags: SourceDefaultTags::default(),
        }
    }
}

impl TransferOptions {
    /// Replaces the Settings-owned part of the options, which the frontend
    /// cannot supply.
    pub fn with_default_tags(mut self, default_tags: SourceDefaultTags) -> Self {
        self.default_tags = default_tags;
        self
    }

    pub(crate) fn limit(&self) -> Option<usize> {
        self.limit.map(NonZeroUsize::get)
    }

    pub(crate) fn default_tags_for(&self, source: DefaultTagSource) -> Vec<String> {
        if !self.include_default_tags {
            return Vec::new();
        }
        match source {
            DefaultTagSource::FieldTheory => self.default_tags.field_theory_tags(),
            DefaultTagSource::Chrome => self.default_tags.chrome_tags(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DefaultTagSource {
    FieldTheory,
    Chrome,
}
