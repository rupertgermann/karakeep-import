use std::{collections::HashSet, error::Error, fmt, fs, path::Path};

use chrono::{DateTime, SecondsFormat, Utc};
use html_escape::decode_html_entities;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use crate::{
    bookmark::BookmarkPreview,
    transfer_options::{DefaultTagSource, SourceDefaultTags, TimestampField, TransferOptions},
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileSourceFormat {
    #[default]
    Auto,
    FieldTheoryJsonl,
    ChromeNetscape,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolvedFileSourceFormat {
    FieldTheoryJsonl,
    ChromeNetscape,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSourcePreview {
    pub format: ResolvedFileSourceFormat,
    pub bookmarks: Vec<BookmarkPreview>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileSourceError {
    message: String,
}

impl FileSourceError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for FileSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for FileSourceError {}

/// Reads the user-selected File Source in place. This function has no storage
/// path and performs no writes, so previewing cannot copy the source into app
/// storage or change the active X Source.
pub fn preview_file(
    path: &Path,
    requested_format: FileSourceFormat,
    options: &TransferOptions,
) -> Result<FileSourcePreview, FileSourceError> {
    let contents = fs::read_to_string(path).map_err(|error| {
        FileSourceError::new(format!(
            "Could not read File Source {}: {error}",
            path.display()
        ))
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    preview_text(file_name, &contents, requested_format, options)
}

/// Parses and maps File Source content without contacting Karakeep.
pub fn preview_text(
    file_name: &str,
    contents: &str,
    requested_format: FileSourceFormat,
    options: &TransferOptions,
) -> Result<FileSourcePreview, FileSourceError> {
    let format = resolve_format(file_name, contents, requested_format);
    let bookmarks = match format {
        ResolvedFileSourceFormat::FieldTheoryJsonl => parse_field_theory(contents, options)?,
        ResolvedFileSourceFormat::ChromeNetscape => parse_chrome(contents, options)?,
    };
    Ok(FileSourcePreview { format, bookmarks })
}

fn resolve_format(
    file_name: &str,
    contents: &str,
    requested_format: FileSourceFormat,
) -> ResolvedFileSourceFormat {
    match requested_format {
        FileSourceFormat::FieldTheoryJsonl => ResolvedFileSourceFormat::FieldTheoryJsonl,
        FileSourceFormat::ChromeNetscape => ResolvedFileSourceFormat::ChromeNetscape,
        FileSourceFormat::Auto => {
            let extension = Path::new(file_name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if matches!(extension.as_str(), "html" | "htm")
                || contents
                    .chars()
                    .take(4096)
                    .collect::<String>()
                    .to_lowercase()
                    .contains("netscape-bookmark-file-1")
            {
                ResolvedFileSourceFormat::ChromeNetscape
            } else {
                ResolvedFileSourceFormat::FieldTheoryJsonl
            }
        }
    }
}

fn parse_field_theory(
    contents: &str,
    options: &TransferOptions,
) -> Result<Vec<BookmarkPreview>, FileSourceError> {
    let mut bookmarks = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_urls = HashSet::new();

    for (index, line) in contents.lines().enumerate() {
        let line_number = index + 1;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line).map_err(|error| {
            FileSourceError::new(format!("Invalid JSON on line {line_number}: {error}"))
        })?;
        let record = value.as_object().ok_or_else(|| {
            FileSourceError::new(format!(
                "Field Theory line {line_number} is not a JSON object"
            ))
        })?;
        let source_id = source_id(record).ok_or_else(|| {
            FileSourceError::new(format!(
                "Field Theory record on line {line_number} has no tweetId, id, or URL"
            ))
        })?;
        let url = string_field(record, "url");
        if !is_web_url(&url) {
            return Err(FileSourceError::new(format!(
                "Record {source_id} on line {line_number} has no valid http(s) URL"
            )));
        }
        if !seen_ids.insert(source_id.clone()) {
            return Err(FileSourceError::new(format!(
                "Duplicate source ID {source_id} on line {line_number}"
            )));
        }
        if !seen_urls.insert(url.clone()) {
            return Err(FileSourceError::new(format!(
                "Duplicate URL {url} on line {line_number}"
            )));
        }
        bookmarks.push(map_field_theory(record, source_id, url, options));
    }

    Ok(bookmarks)
}

fn map_field_theory(
    record: &Map<String, Value>,
    source_id: String,
    url: String,
    options: &TransferOptions,
) -> BookmarkPreview {
    // The internal name only reaches a library when it was asked for, whether
    // it comes from the selected default tags or from the export's own tags.
    let keep_internal_name = options
        .default_tags_for(DefaultTagSource::FieldTheory)
        .iter()
        .any(|tag| tag == SourceDefaultTags::FIELD_THEORY_TAG);
    let folders = if options.include_export_tags {
        deduplicate_tags(
            string_array(record, "tags")
                .into_iter()
                .chain(string_array(record, "folderNames"))
                .filter(|tag| {
                    keep_internal_name
                        || !tag.eq_ignore_ascii_case(SourceDefaultTags::FIELD_THEORY_TAG)
                }),
        )
    } else {
        Vec::new()
    };
    let tags = compose_tags(options, DefaultTagSource::FieldTheory, &folders);

    BookmarkPreview {
        source_id,
        url,
        title: optional_mapping(options.include_titles, || make_field_theory_title(record)),
        note: optional_mapping(options.include_notes, || make_field_theory_note(record)),
        created_at: field_theory_timestamp(record, options.timestamp_field),
        tags,
        folders,
    }
}

/// Composes the tag list from its three independent groups, in the order the
/// command line importer uses, then deduplicates case-insensitively.
fn compose_tags(
    options: &TransferOptions,
    source: DefaultTagSource,
    export_tags: &[String],
) -> Vec<String> {
    deduplicate_tags(
        options
            .default_tags_for(source)
            .into_iter()
            .chain(options.extra_tags.iter().cloned())
            .chain(export_tags.iter().cloned()),
    )
}

fn optional_mapping(include: bool, map: impl FnOnce() -> String) -> String {
    if include { map() } else { String::new() }
}

/// Resolves the selected timestamp field for a Field Theory record. A missing
/// or unparseable value omits `createdAt` rather than failing the record.
fn field_theory_timestamp(record: &Map<String, Value>, field: TimestampField) -> Option<String> {
    let key = match field {
        TimestampField::None => return None,
        TimestampField::Source | TimestampField::PostedAt => "postedAt",
        TimestampField::BookmarkedAt => "bookmarkedAt",
        TimestampField::AddedAt => "addedAt",
    };
    parse_timestamp(record.get(key))
}

/// Resolves the selected timestamp field for a Chrome record, whose only
/// timestamp is the `ADD_DATE` attribute.
fn chrome_timestamp(added_at: &str, field: TimestampField) -> Option<String> {
    match field {
        TimestampField::Source | TimestampField::AddedAt => parse_timestamp_string(added_at),
        TimestampField::PostedAt | TimestampField::BookmarkedAt | TimestampField::None => None,
    }
}

fn source_id(record: &Map<String, Value>) -> Option<String> {
    ["tweetId", "id", "url"]
        .iter()
        .find_map(|key| nonblank_scalar_string(record.get(*key)))
}

fn nonblank_scalar_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        }
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn string_field(record: &Map<String, Value>, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn string_array(record: &Map<String, Value>, key: &str) -> Vec<String> {
    record
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(compact_text)
        .filter(|value| !value.is_empty())
        .collect()
}

fn author_label(record: &Map<String, Value>) -> String {
    let name = compact_text(&string_field(record, "authorName"));
    let handle = compact_text(&string_field(record, "authorHandle"))
        .trim_start_matches('@')
        .to_string();
    match (name.is_empty(), handle.is_empty()) {
        (false, false) => format!("{name} (@{handle})"),
        (true, false) => format!("@{handle}"),
        (false, true) => name,
        (true, true) => "Unknown author".to_string(),
    }
}

fn make_field_theory_title(record: &Map<String, Value>) -> String {
    const MAX_TITLE_LENGTH: usize = 300;

    let explicit = compact_text(&string_field(record, "title"));
    if !explicit.is_empty() {
        return truncate(&explicit, MAX_TITLE_LENGTH);
    }

    let author = author_label(record);
    let text = compact_text(&string_field(record, "text"));
    if text.is_empty() {
        return truncate(&author, MAX_TITLE_LENGTH);
    }
    let prefix = format!("{author}: ");
    let prefix_length = prefix.chars().count();
    let available = MAX_TITLE_LENGTH.saturating_sub(prefix_length).max(1);
    let excerpt = if text.chars().count() <= available {
        text
    } else {
        let shortened = truncate(&text, available.saturating_sub(1).max(1));
        format!("{}…", shortened.trim_end())
    };
    truncate(&format!("{prefix}{excerpt}"), MAX_TITLE_LENGTH)
}

fn make_field_theory_note(record: &Map<String, Value>) -> String {
    let mut sections = Vec::new();
    let text = string_field(record, "text");
    if !text.is_empty() {
        sections.push(text);
    }

    if let Some(quoted) = record.get("quotedTweet").and_then(Value::as_object) {
        let quoted_text = string_field(quoted, "text");
        if !quoted_text.is_empty() {
            let quoted_block = quoted_text.replace('\n', "\n> ");
            sections.push(format!(
                "> Quoted from {}:\n> {quoted_block}",
                author_label(quoted)
            ));
        }
    }

    let mut metadata = vec![format!("Author: {}", author_label(record))];
    if let Some(posted_at) = parse_timestamp(record.get("postedAt")) {
        metadata.push(format!("Posted: {posted_at}"));
    }
    if let Some(tweet_id) = nonblank_scalar_string(record.get("tweetId"))
        .or_else(|| nonblank_scalar_string(record.get("id")))
    {
        metadata.push(format!("Tweet ID: {tweet_id}"));
    }

    let linked_urls = deduplicate_exact(
        string_array(record, "links")
            .into_iter()
            .filter(|link| is_web_url(link)),
    );
    if !linked_urls.is_empty() {
        metadata.push(format!("Linked URLs: {}", linked_urls.join(", ")));
    }
    if let Some(media) = record.get("mediaObjects").and_then(Value::as_array)
        && !media.is_empty()
    {
        metadata.push(format!(
            "Media items in Field Theory archive: {}",
            media.len()
        ));
    }

    sections.push(metadata.join("\n"));
    sections.push("Transferred from Field Theory.".to_string());
    sections.join("\n\n")
}

struct ChromeParser<'a> {
    options: &'a TransferOptions,
    bookmarks: Vec<BookmarkPreview>,
    folders: Vec<String>,
    folder_depths: Vec<bool>,
    pending_folder: Option<String>,
    folder_text: Option<String>,
    bookmark: Option<ChromeBookmarkCapture>,
}

#[derive(Default)]
struct ChromeBookmarkCapture {
    href: String,
    added_at: String,
    title: String,
}

impl<'a> ChromeParser<'a> {
    fn new(options: &'a TransferOptions) -> Self {
        Self {
            options,
            bookmarks: Vec::new(),
            folders: Vec::new(),
            folder_depths: Vec::new(),
            pending_folder: None,
            folder_text: None,
            bookmark: None,
        }
    }

    fn start_tag(&mut self, name: &str, attributes: &str) -> bool {
        match name {
            "h3" => self.folder_text = Some(String::new()),
            "dl" => {
                let has_folder = self.pending_folder.is_some();
                if let Some(folder) = self.pending_folder.take() {
                    self.folders.push(folder);
                }
                self.folder_depths.push(has_folder);
            }
            "a" => {
                let (attributes, self_closing) = parse_attributes(attributes);
                self.bookmark = Some(ChromeBookmarkCapture {
                    href: attributes
                        .iter()
                        .find(|(name, _)| name == "href")
                        .map(|(_, value)| value.clone())
                        .unwrap_or_default(),
                    added_at: attributes
                        .iter()
                        .find(|(name, _)| name == "add_date")
                        .map(|(_, value)| value.clone())
                        .unwrap_or_default(),
                    title: String::new(),
                });
                return self_closing;
            }
            _ => {}
        }
        attributes.ends_with('/')
    }

    fn text(&mut self, text: &str) {
        let decoded = decode_html_entities(text);
        if let Some(bookmark) = &mut self.bookmark {
            bookmark.title.push_str(&decoded);
        } else if let Some(folder) = &mut self.folder_text {
            folder.push_str(&decoded);
        }
    }

    fn end_tag(&mut self, name: &str) -> Result<(), FileSourceError> {
        match name {
            "h3" => {
                self.pending_folder = self
                    .folder_text
                    .take()
                    .map(|value| compact_text(&value))
                    .filter(|value| !value.is_empty());
            }
            "a" => self.finish_bookmark()?,
            "dl" if self.folder_depths.pop() == Some(true) => {
                self.folders.pop();
            }
            _ => {}
        }
        Ok(())
    }

    fn finish_bookmark(&mut self) -> Result<(), FileSourceError> {
        let Some(bookmark) = self.bookmark.take() else {
            return Ok(());
        };
        let title = compact_text(&bookmark.title);
        let url = normalize_chrome_url(&bookmark.href).ok_or_else(|| {
            FileSourceError::new(format!(
                "Chrome bookmark {} has no supported http(s) URL",
                if title.is_empty() {
                    "(untitled)"
                } else {
                    &title
                }
            ))
        })?;
        let created_at = chrome_timestamp(&bookmark.added_at, self.options.timestamp_field);
        let folders: Vec<String> = if self.options.include_export_tags {
            self.folders
                .iter()
                .map(|folder| compact_text(folder))
                .filter(|folder| !folder.is_empty())
                .collect()
        } else {
            Vec::new()
        };
        let tags = compose_tags(self.options, DefaultTagSource::Chrome, &folders);
        let mut metadata = Vec::new();
        if !self.folders.is_empty() {
            metadata.push(format!("Chrome folder: {}", self.folders.join(" > ")));
        }
        if let Some(timestamp) = &created_at {
            metadata.push(format!("Added to Chrome: {timestamp}"));
        }
        metadata.push("Transferred from Chrome bookmarks.".to_string());

        self.bookmarks.push(BookmarkPreview {
            source_id: url.clone(),
            url,
            title: optional_mapping(self.options.include_titles, || truncate(&title, 300)),
            note: optional_mapping(self.options.include_notes, || metadata.join("\n")),
            created_at,
            tags,
            folders,
        });
        Ok(())
    }
}

fn parse_chrome(
    contents: &str,
    options: &TransferOptions,
) -> Result<Vec<BookmarkPreview>, FileSourceError> {
    let mut parser = ChromeParser::new(options);
    tokenize_html(contents, &mut parser)?;

    let mut seen_urls = HashSet::new();
    for (index, bookmark) in parser.bookmarks.iter().enumerate() {
        if !seen_urls.insert(bookmark.url.clone()) {
            return Err(FileSourceError::new(format!(
                "Duplicate URL {} in Chrome bookmark {}",
                bookmark.url,
                index + 1
            )));
        }
    }
    Ok(parser.bookmarks)
}

fn tokenize_html(contents: &str, parser: &mut ChromeParser<'_>) -> Result<(), FileSourceError> {
    let mut cursor = 0;
    while let Some(relative_start) = contents[cursor..].find('<') {
        let start = cursor + relative_start;
        parser.text(&contents[cursor..start]);
        let Some(end) = find_tag_end(contents, start + 1) else {
            return Err(FileSourceError::new(
                "Chrome bookmarks HTML has an unterminated tag",
            ));
        };
        let raw = contents[start + 1..end].trim();
        cursor = end + 1;
        if raw.is_empty() || raw.starts_with('!') || raw.starts_with('?') {
            continue;
        }

        let is_end = raw.starts_with('/');
        let body = raw.trim_start_matches('/').trim_start();
        let name_end = body
            .find(|character: char| character.is_ascii_whitespace() || character == '/')
            .unwrap_or(body.len());
        let name = body[..name_end].to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        if is_end {
            parser.end_tag(&name)?;
        } else {
            let self_closing = parser.start_tag(&name, body[name_end..].trim());
            if self_closing {
                parser.end_tag(&name)?;
            }
        }
    }
    parser.text(&contents[cursor..]);
    Ok(())
}

fn find_tag_end(contents: &str, start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, character) in contents[start..].char_indices() {
        match (quote, character) {
            (Some(active), current) if current == active => quote = None,
            (None, '"' | '\'') => quote = Some(character),
            (None, '>') => return Some(start + offset),
            _ => {}
        }
    }
    None
}

fn parse_attributes(input: &str) -> (Vec<(String, String)>, bool) {
    let bytes = input.as_bytes();
    let mut attributes = Vec::new();
    let mut cursor = 0;

    while cursor < bytes.len() {
        while cursor < bytes.len() && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b'/')
        {
            if bytes[cursor] == b'/' && cursor + 1 == bytes.len() {
                return (attributes, true);
            }
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len()
            && !bytes[cursor].is_ascii_whitespace()
            && bytes[cursor] != b'='
            && bytes[cursor] != b'/'
        {
            cursor += 1;
        }
        if name_start == cursor {
            break;
        }
        let name = input[name_start..cursor].to_ascii_lowercase();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let mut value = String::new();
        if cursor < bytes.len() && bytes[cursor] == b'=' {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
                let quote = bytes[cursor];
                cursor += 1;
                let value_start = cursor;
                while cursor < bytes.len() && bytes[cursor] != quote {
                    cursor += 1;
                }
                value = decode_html_entities(&input[value_start..cursor]).into_owned();
                if cursor < bytes.len() {
                    cursor += 1;
                }
            } else {
                let value_start = cursor;
                while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                value = decode_html_entities(&input[value_start..cursor]).into_owned();
            }
        }
        attributes.push((name, value));
    }
    (attributes, false)
}

fn normalize_chrome_url(raw_url: &str) -> Option<String> {
    let mut normalized = raw_url.trim();
    if normalized
        .get(..12)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("view-source:"))
    {
        normalized = normalized[12..].trim();
    }
    is_web_url(normalized).then(|| normalized.to_string())
}

fn is_web_url(raw_url: &str) -> bool {
    Url::parse(raw_url)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

fn parse_timestamp(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(parse_timestamp_string)
}

fn parse_timestamp_string(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let timestamp = if raw.chars().all(|character| character.is_ascii_digit()) {
        let seconds = raw.parse::<i64>().ok()?;
        DateTime::<Utc>::from_timestamp(seconds, 0)?
    } else if let Ok(timestamp) = DateTime::parse_from_str(raw, "%a %b %d %H:%M:%S %z %Y") {
        timestamp.with_timezone(&Utc)
    } else {
        DateTime::parse_from_rfc3339(raw).ok()?.with_timezone(&Utc)
    };
    Some(timestamp.to_rfc3339_opts(SecondsFormat::AutoSi, true))
}

fn compact_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(value: &str, max_length: usize) -> String {
    value.chars().take(max_length).collect()
}

fn deduplicate_tags(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| compact_text(&value))
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.to_lowercase()))
        .collect()
}

fn deduplicate_exact(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
