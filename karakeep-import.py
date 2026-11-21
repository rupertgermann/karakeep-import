#!/usr/bin/env python3
"""Import Field Theory or Chrome bookmarks into Karakeep.

The script is a dry run unless --execute is supplied. It intentionally uses only
Python's standard library so it can run without installing project dependencies.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import hashlib
import itertools
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Mapping, Sequence


DEFAULT_INPUT = Path.home() / ".ft-bookmarks" / "bookmarks.jsonl"
DEFAULT_SERVER = "https://karakeep.example.com"
FIELD_THEORY_DEFAULT_TAGS = ("twitter", "fieldtheory")
CHROME_DEFAULT_TAGS = ("chrome",)
USER_AGENT = "bookmarks-to-karakeep/1.0"
HTTP_DEFAULT_PORTS = {"http": 80, "https": 443}


class ImportFailure(RuntimeError):
    """A record could not be imported."""


class ApiFailure(ImportFailure):
    """Karakeep returned a permanent API error."""

    def __init__(self, method: str, url: str, status: int | None, detail: str):
        status_text = str(status) if status is not None else "network error"
        super().__init__(f"{method} {url} failed ({status_text}): {detail}")
        self.status = status


@dataclasses.dataclass(frozen=True)
class ApiResponse:
    status: int
    body: Any


@dataclasses.dataclass(frozen=True)
class ImportResult:
    source_id: str
    outcome: str
    bookmark_id: str | None = None
    error: str | None = None


class RateLimiter:
    """Simple process-wide request rate limiter."""

    def __init__(self, requests_per_second: float):
        if requests_per_second <= 0:
            raise ValueError("requests_per_second must be greater than zero")
        self._interval = 1.0 / requests_per_second
        self._next_slot = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_slot)
            self._next_slot = slot + self._interval
        delay = slot - now
        if delay > 0:
            time.sleep(delay)


def _request_origin(parts: urllib.parse.SplitResult) -> tuple[str, str, int]:
    hostname = parts.hostname
    if (
        hostname is None
        or parts.username is not None
        or parts.scheme not in HTTP_DEFAULT_PORTS
    ):
        raise ValueError("Invalid HTTP origin")
    port = parts.port
    if port is None:
        port = HTTP_DEFAULT_PORTS[parts.scheme]
    return parts.scheme, hostname, port


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            current = _request_origin(urllib.parse.urlsplit(req.full_url))
            target = _request_origin(urllib.parse.urlsplit(newurl))
            if current != target:
                return None
        except ValueError:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class KarakeepClient:
    def __init__(
        self,
        server: str,
        api_key: str,
        *,
        requests_per_second: float = 4.0,
        timeout: float = 30.0,
        max_retries: int = 5,
    ):
        self.api_base = normalize_api_base(server)
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.rate_limiter = RateLimiter(requests_per_second)
        self._opener = urllib.request.build_opener(_SameOriginRedirectHandler())

    def preflight(self) -> Mapping[str, Any]:
        response = self._request("GET", "/users/me")
        if not isinstance(response.body, Mapping):
            raise ApiFailure(
                "GET",
                f"{self.api_base}/users/me",
                response.status,
                "invalid JSON response",
            )
        return response.body

    def create_bookmark(self, payload: Mapping[str, Any]) -> ApiResponse:
        return self._request("POST", "/bookmarks", payload)

    def attach_tags(self, bookmark_id: str, tags: Sequence[str]) -> ApiResponse:
        encoded_id = urllib.parse.quote(bookmark_id, safe="")
        payload = {
            "tags": [
                {"tagName": tag, "attachedBy": "human"}
                for tag in tags
            ]
        }
        return self._request("POST", f"/bookmarks/{encoded_id}/tags", payload)

    def _request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
    ) -> ApiResponse:
        url = f"{self.api_base}{path}"
        data = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": USER_AGENT,
        }
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"

        for attempt in range(self.max_retries + 1):
            self.rate_limiter.wait()
            request = urllib.request.Request(
                url, data=data, headers=headers, method=method
            )
            try:
                with self._opener.open(request, timeout=self.timeout) as response:
                    raw_body = response.read()
                    return ApiResponse(
                        status=response.status,
                        body=decode_response_body(raw_body),
                    )
            except urllib.error.HTTPError as error:
                try:
                    raw_body = error.read()
                finally:
                    error.close()
                detail = redact_secret(
                    response_detail(raw_body),
                    self.api_key,
                )
                retryable = error.code == 429 or 500 <= error.code <= 599
                if retryable and attempt < self.max_retries:
                    delay = retry_delay(attempt, error.headers.get("Retry-After"))
                    time.sleep(delay)
                    continue
                raise ApiFailure(method, url, error.code, detail) from error
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                if attempt < self.max_retries:
                    time.sleep(retry_delay(attempt, None))
                    continue
                raise ApiFailure(
                    method,
                    url,
                    None,
                    redact_secret(str(error), self.api_key),
                ) from error

        raise AssertionError("retry loop exited unexpectedly")


class JsonlLog:
    """Thread-safe append-only JSONL log."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def append(self, value: Mapping[str, Any]) -> None:
        line = json.dumps(value, ensure_ascii=False, sort_keys=True)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(f"{line}\n")
                stream.flush()


class StateStore(JsonlLog):
    def __init__(self, path: Path, *, api_base: str, account_id: str) -> None:
        super().__init__(path)
        identity = json.dumps([api_base, account_id]).encode("utf-8")
        self._destination_id = hashlib.sha256(identity).hexdigest()

    def completed_ids(self) -> set[str]:
        if not self.path.exists():
            return set()

        completed: set[str] = set()
        with self.path.open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ImportFailure(
                        f"Invalid state JSON on line {line_number} of {self.path}: {error}"
                    ) from error
                if (
                    value.get("destinationId") == self._destination_id
                    and value.get("status") == "complete"
                    and value.get("sourceId")
                ):
                    completed.add(str(value["sourceId"]))
        return completed

    def mark_complete(
        self, source_id: str, bookmark_id: str, outcome: str
    ) -> None:
        self.append(
            {
                "destinationId": self._destination_id,
                "sourceId": source_id,
                "bookmarkId": bookmark_id,
                "outcome": outcome,
                "status": "complete",
                "completedAt": utc_now(),
            }
        )


def normalize_api_base(server: str) -> str:
    raw = server.strip()
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in HTTP_DEFAULT_PORTS or not parsed.netloc:
        raise ValueError(
            "--server must be an absolute http(s) URL, for example "
            "https://karakeep.example.com"
        )
    if parsed.query or parsed.fragment:
        raise ValueError("--server must not contain a query string or fragment")

    scheme, hostname, port = _request_origin(parsed)
    authority = f"[{hostname}]" if ":" in hostname else hostname
    if port != HTTP_DEFAULT_PORTS[scheme]:
        authority = f"{authority}:{port}"

    path = parsed.path.rstrip("/")
    if "/dashboard" in path:
        path = path.split("/dashboard", maxsplit=1)[0].rstrip("/")
    if path.endswith("/api/v1"):
        api_path = path
    else:
        api_path = f"{path}/api/v1"
    return urllib.parse.urlunsplit(
        (scheme, authority, api_path, "", "")
    )


def decode_response_body(raw_body: bytes) -> Any:
    if not raw_body:
        return None
    text = raw_body.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def response_detail(raw_body: bytes) -> str:
    body = decode_response_body(raw_body)
    if isinstance(body, Mapping):
        for key in ("message", "error", "detail"):
            if body.get(key):
                return str(body[key])[:1000]
        return json.dumps(body, ensure_ascii=False)[:1000]
    return str(body or "empty response")[:1000]


def redact_secret(value: str, secret: str) -> str:
    return value.replace(secret, "[REDACTED]") if secret else value


def retry_delay(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            return min(max(float(retry_after), 0.0), 120.0)
        except ValueError:
            pass
    exponential = min(2**attempt, 30)
    return exponential + random.uniform(0.0, 0.25)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def source_id(record: Mapping[str, Any]) -> str:
    for key in ("tweetId", "id", "url"):
        value = record.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    raise ImportFailure("Record has no tweetId, id, or URL")


class ChromeBookmarksParser(HTMLParser):
    """Parse Chrome's Netscape bookmark export into importer records."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.records: list[dict[str, Any]] = []
        self._folders: list[str] = []
        self._folder_depths: list[bool] = []
        self._pending_folder: str | None = None
        self._folder_text: list[str] | None = None
        self._bookmark_attributes: dict[str, str | None] | None = None
        self._bookmark_text: list[str] | None = None

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        tag = tag.casefold()
        if tag == "h3":
            self._folder_text = []
        elif tag == "dl":
            has_folder = self._pending_folder is not None
            if self._pending_folder is not None:
                self._folders.append(self._pending_folder)
                self._pending_folder = None
            self._folder_depths.append(has_folder)
        elif tag == "a":
            self._bookmark_attributes = {
                key.casefold(): value for key, value in attrs
            }
            self._bookmark_text = []

    def handle_data(self, data: str) -> None:
        if self._bookmark_text is not None:
            self._bookmark_text.append(data)
        elif self._folder_text is not None:
            self._folder_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag == "h3" and self._folder_text is not None:
            folder = compact_text("".join(self._folder_text))
            self._pending_folder = folder or None
            self._folder_text = None
        elif tag == "a" and self._bookmark_attributes is not None:
            self._finish_bookmark()
        elif tag == "dl" and self._folder_depths:
            if self._folder_depths.pop():
                self._folders.pop()

    def _finish_bookmark(self) -> None:
        attributes = self._bookmark_attributes or {}
        title = compact_text("".join(self._bookmark_text or []))
        self._bookmark_attributes = None
        self._bookmark_text = None

        raw_url = str(attributes.get("href") or "").strip()
        url = normalize_chrome_url(raw_url)
        if not url:
            raise ImportFailure(
                f"Chrome bookmark {title or '(untitled)'} has no supported http(s) URL"
            )

        folders = list(self._folders)
        self.records.append(
            {
                "sourceType": "chrome",
                "url": url,
                "title": title,
                "addedAt": str(attributes.get("add_date") or "").strip(),
                "folders": folders,
                "tags": folders,
            }
        )


def normalize_chrome_url(url: str) -> str | None:
    normalized = url.strip()
    if normalized.casefold().startswith("view-source:"):
        normalized = normalized[len("view-source:") :]
    parsed = urllib.parse.urlsplit(normalized)
    if parsed.scheme.casefold() in {"http", "https"} and parsed.netloc:
        return normalized
    return None


def detect_input_format(path: Path) -> str:
    if path.suffix.casefold() in {".html", ".htm"}:
        return "chrome"
    if path.suffix.casefold() in {".jsonl", ".json"}:
        return "fieldtheory"

    with path.open(encoding="utf-8") as stream:
        prefix = stream.read(4096).casefold()
    if "netscape-bookmark-file-1" in prefix:
        return "chrome"
    return "fieldtheory"


def load_input(
    path: Path, input_format: str = "auto"
) -> tuple[list[dict[str, Any]], str]:
    if not path.is_file():
        raise ImportFailure(f"Input file does not exist: {path}")

    resolved_format = (
        detect_input_format(path) if input_format == "auto" else input_format
    )
    if resolved_format == "chrome":
        parser = ChromeBookmarksParser()
        parser.feed(path.read_text(encoding="utf-8"))
        seen_urls: set[str] = set()
        for position, record in enumerate(parser.records, start=1):
            url = str(record["url"])
            if url in seen_urls:
                raise ImportFailure(
                    f"Duplicate URL {url} in Chrome bookmark {position}"
                )
            seen_urls.add(url)
        return parser.records, resolved_format
    if resolved_format != "fieldtheory":
        raise ImportFailure(f"Unsupported input format: {resolved_format}")

    records: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ImportFailure(
                    f"Invalid JSON on line {line_number} of {path}: {error}"
                ) from error
            if not isinstance(value, dict):
                raise ImportFailure(
                    f"Line {line_number} of {path} is not a JSON object"
                )
            record_id = source_id(value)
            url = value.get("url")
            if not isinstance(url, str) or not url.startswith(
                ("http://", "https://")
            ):
                raise ImportFailure(
                    f"Record {record_id} on line {line_number} has no valid http(s) URL"
                )
            if record_id in seen_ids:
                raise ImportFailure(
                    f"Duplicate source ID {record_id} on line {line_number}"
                )
            if url in seen_urls:
                raise ImportFailure(f"Duplicate URL {url} on line {line_number}")
            seen_ids.add(record_id)
            seen_urls.add(url)
            records.append(value)
    return records, resolved_format


def load_records(
    path: Path, input_format: str = "auto"
) -> list[dict[str, Any]]:
    records, _ = load_input(path, input_format)
    return records


def parse_timestamp(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None

    raw = value.strip()
    if raw.isdigit():
        try:
            return (
                dt.datetime.fromtimestamp(int(raw), dt.timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        except (OverflowError, OSError, ValueError):
            return None

    formats = (
        "%a %b %d %H:%M:%S %z %Y",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S%z",
    )
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    for time_format in formats:
        try:
            parsed = dt.datetime.strptime(normalized, time_format)
            return (
                parsed.astimezone(dt.timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        except ValueError:
            continue
    return None


def compact_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()


def author_label(record: Mapping[str, Any]) -> str:
    name = compact_text(record.get("authorName"))
    handle = compact_text(record.get("authorHandle")).lstrip("@")
    if name and handle:
        return f"{name} (@{handle})"
    if handle:
        return f"@{handle}"
    return name or "Unknown author"


def make_title(record: Mapping[str, Any], max_length: int = 300) -> str:
    title = compact_text(record.get("title"))
    if title:
        return title[:max_length]

    text = compact_text(record.get("text"))
    prefix = f"{author_label(record)}: "
    if not text:
        return prefix.rstrip(": ")[:max_length]
    available = max(max_length - len(prefix), 1)
    excerpt = (
        text
        if len(text) <= available
        else f"{text[: max(available - 1, 1)].rstrip()}…"
    )
    return f"{prefix}{excerpt}"[:max_length]


def make_note(record: Mapping[str, Any]) -> str:
    if record.get("sourceType") == "chrome":
        metadata: list[str] = []
        folders = record.get("folders")
        if isinstance(folders, list):
            folder_names = [
                compact_text(folder)
                for folder in folders
                if compact_text(folder)
            ]
            if folder_names:
                metadata.append("Chrome folder: " + " > ".join(folder_names))
        added_at = parse_timestamp(record.get("addedAt"))
        if added_at:
            metadata.append(f"Added to Chrome: {added_at}")
        metadata.append("Imported from Chrome bookmarks.")
        return "\n".join(metadata)

    sections: list[str] = []
    text = str(record.get("text") or "").strip()
    if text:
        sections.append(text)

    metadata: list[str] = [f"Author: {author_label(record)}"]
    posted_at = parse_timestamp(record.get("postedAt"))
    if posted_at:
        metadata.append(f"Posted: {posted_at}")
    tweet_id = record.get("tweetId") or record.get("id")
    if tweet_id:
        metadata.append(f"Tweet ID: {tweet_id}")

    links = record.get("links")
    if isinstance(links, list):
        valid_links = [
            link for link in links
            if isinstance(link, str) and link.startswith(("http://", "https://"))
        ]
        if valid_links:
            metadata.append("Linked URLs: " + ", ".join(dict.fromkeys(valid_links)))

    media_objects = record.get("mediaObjects")
    if isinstance(media_objects, list) and media_objects:
        metadata.append(f"Media items in Field Theory archive: {len(media_objects)}")

    quoted = record.get("quotedTweet")
    if isinstance(quoted, Mapping):
        quoted_text = str(quoted.get("text") or "").strip()
        if quoted_text:
            quoted_author = author_label(quoted)
            quoted_block = quoted_text.replace(chr(10), chr(10) + "> ")
            sections.append(f"> Quoted from {quoted_author}:\n> {quoted_block}")

    sections.append("\n".join(metadata))
    sections.append("Imported from Field Theory.")
    return "\n\n".join(sections)


def record_tags(
    record: Mapping[str, Any],
    *,
    extra_tags: Sequence[str],
    include_default_tags: bool,
    include_export_tags: bool,
) -> list[str]:
    tags: list[str] = []
    if include_default_tags:
        tags.extend(default_tags(record))
    tags.extend(extra_tags)
    if include_export_tags:
        exported = record.get("tags")
        if isinstance(exported, list):
            tags.extend(tag for tag in exported if isinstance(tag, str))

    result: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        normalized = compact_text(tag)
        if normalized and normalized.casefold() not in seen:
            seen.add(normalized.casefold())
            result.append(normalized)
    return result


def default_tags(record: Mapping[str, Any]) -> tuple[str, ...]:
    if record.get("sourceType") == "chrome":
        return CHROME_DEFAULT_TAGS
    return FIELD_THEORY_DEFAULT_TAGS


def timestamp_field_for_record(
    record: Mapping[str, Any], timestamp_field: str
) -> str:
    if timestamp_field == "source":
        return "addedAt" if record.get("sourceType") == "chrome" else "postedAt"
    return timestamp_field


def bookmark_payload(
    record: Mapping[str, Any],
    *,
    include_title: bool,
    include_note: bool,
    timestamp_field: str,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "link",
        "url": record["url"],
        "crawlPriority": "low",
        "source": "import",
    }
    if include_title:
        payload["title"] = make_title(record)
    if include_note:
        payload["note"] = make_note(record)
    if timestamp_field != "none":
        resolved_timestamp_field = timestamp_field_for_record(
            record, timestamp_field
        )
        timestamp = parse_timestamp(record.get(resolved_timestamp_field))
        if timestamp:
            payload["createdAt"] = timestamp
    return payload


def import_one(
    record: Mapping[str, Any],
    *,
    client: KarakeepClient,
    state: StateStore,
    errors: JsonlLog,
    extra_tags: Sequence[str],
    include_default_tags: bool,
    include_export_tags: bool,
    include_title: bool,
    include_note: bool,
    timestamp_field: str,
) -> ImportResult:
    record_id = source_id(record)
    try:
        payload = bookmark_payload(
            record,
            include_title=include_title,
            include_note=include_note,
            timestamp_field=timestamp_field,
        )
        response = client.create_bookmark(payload)
        if not isinstance(response.body, Mapping) or not response.body.get("id"):
            raise ImportFailure(
                f"Create response for source {record_id} has no bookmark ID"
            )
        bookmark_id = str(response.body["id"])
        outcome = "created" if response.status == 201 else "existing"

        tags = record_tags(
            record,
            extra_tags=extra_tags,
            include_default_tags=include_default_tags,
            include_export_tags=include_export_tags,
        )
        if tags:
            client.attach_tags(bookmark_id, tags)

        state.mark_complete(record_id, bookmark_id, outcome)
        return ImportResult(record_id, outcome, bookmark_id=bookmark_id)
    except Exception as error:
        message = redact_secret(str(error), client.api_key)
        errors.append(
            {
                "sourceId": record_id,
                "url": record.get("url"),
                "error": message,
                "failedAt": utc_now(),
            }
        )
        if isinstance(error, ApiFailure) and error.status == 401:
            raise ImportFailure(
                "Karakeep rejected the API key during import. "
                "Update the key and rerun to resume incomplete records."
            ) from error
        return ImportResult(record_id, "failed", error=message)


def choose_records(
    records: Sequence[Mapping[str, Any]],
    completed_ids: set[str],
    limit: int | None,
) -> tuple[list[Mapping[str, Any]], int]:
    pending = [record for record in records if source_id(record) not in completed_ids]
    skipped = len(records) - len(pending)
    if limit is not None:
        pending = pending[:limit]
    return pending, skipped


def dry_run_summary(
    records: Sequence[Mapping[str, Any]],
    args: argparse.Namespace,
    input_format: str,
) -> None:
    pending = records if args.limit is None else records[: args.limit]
    timestamp_count = sum(
        1
        for record in pending
        if args.timestamp_field != "none"
        and parse_timestamp(
            record.get(
                timestamp_field_for_record(record, args.timestamp_field)
            )
        )
    )
    media_count = sum(
        1
        for record in pending
        if isinstance(record.get("mediaObjects"), list) and record["mediaObjects"]
    )
    print("Dry run only; no data was sent to Karakeep.")
    print(
        "Input format: "
        + (
            "Chrome bookmarks HTML"
            if input_format == "chrome"
            else "Field Theory JSONL"
        )
    )
    print(f"Input records: {len(records)}")
    print("Prior completions are checked after authentication during live import.")
    print(f"Pending in this run: {len(pending)} before the resume check")
    print(f"Records with preserved {args.timestamp_field} timestamp: {timestamp_count}")
    print(f"Records whose notes mention archived media: {media_count}")
    tag_names: list[str] = []
    if not args.no_default_tags:
        for record in pending or records:
            for tag in default_tags(record):
                if tag not in tag_names:
                    tag_names.append(tag)
    tag_names.extend(args.tag)
    print(f"Static tags: {', '.join(tag_names) if tag_names else '(none)'}")
    print(f"Target API: {normalize_api_base(args.server)}")
    print("Run again with --execute after setting KARAKEEP_API_KEY.")


def run(args: argparse.Namespace) -> int:
    records, input_format = load_input(args.input, args.input_format)

    if not args.execute:
        dry_run_summary(records, args, input_format)
        return 0

    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise ImportFailure(
            f"{args.api_key_env} is not set. Generate a Karakeep API key under "
            "Settings > API Keys and export it only in your current shell."
        )
    client = KarakeepClient(
        args.server,
        api_key,
        requests_per_second=args.requests_per_second,
        timeout=args.timeout,
        max_retries=args.max_retries,
    )
    account_id = client.preflight().get("id")
    if not isinstance(account_id, str) or not account_id.strip():
        raise ImportFailure(
            "Karakeep did not return an account ID for resume history."
        )

    state = StateStore(
        args.state_file, api_base=client.api_base, account_id=account_id
    )
    pending, skipped = choose_records(records, state.completed_ids(), args.limit)
    if not pending:
        print(f"Nothing to import; all {len(records)} records are already complete.")
        return 0

    print(
        f"Authenticated. Importing {len(pending)} record(s) to "
        f"{client.api_base} with {args.workers} worker(s)."
    )
    if skipped:
        print(f"Skipping {skipped} record(s) already present in {args.state_file}.")

    results: list[ImportResult] = []
    kwargs = {
        "client": client,
        "state": state,
        "errors": JsonlLog(args.failure_file),
        "extra_tags": args.tag,
        "include_default_tags": not args.no_default_tags,
        "include_export_tags": not args.no_export_tags,
        "include_title": not args.no_titles,
        "include_note": not args.no_notes,
        "timestamp_field": args.timestamp_field,
    }
    remaining = iter(pending)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = set()
        try:
            while True:
                for record in itertools.islice(remaining, args.workers - len(futures)):
                    futures.add(executor.submit(import_one, record, **kwargs))
                if not futures:
                    break
                finished, futures = concurrent.futures.wait(
                    futures, return_when=concurrent.futures.FIRST_COMPLETED
                )
                for future in finished:
                    results.append(future.result())
                    position = len(results)
                    if position == 1 or position % args.progress_every == 0:
                        failed = sum(item.outcome == "failed" for item in results)
                        print(f"Progress: {position}/{len(pending)} ({failed} failed)")
        finally:
            for future in futures:
                future.cancel()

    created = sum(result.outcome == "created" for result in results)
    existing = sum(result.outcome == "existing" for result in results)
    failed_results = [result for result in results if result.outcome == "failed"]
    print(
        f"Finished: {created} created, {existing} already existed, "
        f"{len(failed_results)} failed."
    )
    if failed_results:
        print(
            f"Failure details were written to {args.failure_file}. "
            "Rerun the same command to retry incomplete records.",
            file=sys.stderr,
        )
        return 1
    return 0


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Import Field Theory or Chrome bookmarks into Karakeep.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=DEFAULT_INPUT,
        help="Field Theory JSONL or Chrome bookmarks HTML export",
    )
    parser.add_argument(
        "--input-format",
        choices=("auto", "fieldtheory", "chrome"),
        default="auto",
        help="input format; auto detects it from the filename and content",
    )
    parser.add_argument(
        "--server",
        default=os.environ.get("KARAKEEP_SERVER_ADDR", DEFAULT_SERVER),
        help="Karakeep root, dashboard, or /api/v1 URL",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="perform the live import (without this flag, only show a dry run)",
    )
    parser.add_argument(
        "--api-key-env",
        default="KARAKEEP_API_KEY",
        help="environment variable containing the Karakeep API key",
    )
    parser.add_argument(
        "--tag",
        action="append",
        default=[],
        help="additional static tag; may be specified more than once",
    )
    parser.add_argument(
        "--no-default-tags",
        action="store_true",
        help="do not attach source tags (twitter/fieldtheory or chrome)",
    )
    parser.add_argument(
        "--no-export-tags",
        action="store_true",
        help="do not preserve Field Theory tags or Chrome folder names",
    )
    parser.add_argument(
        "--no-titles",
        action="store_true",
        help="let Karakeep crawl titles instead of preserving source titles",
    )
    parser.add_argument(
        "--no-notes",
        action="store_true",
        help="do not preserve source content and metadata as a Karakeep note",
    )
    parser.add_argument(
        "--timestamp-field",
        choices=("source", "postedAt", "bookmarkedAt", "addedAt", "none"),
        default="source",
        help="source timestamp field to store as Karakeep createdAt",
    )
    parser.add_argument(
        "--workers",
        type=positive_int,
        default=4,
        help="number of concurrent bookmark workers",
    )
    parser.add_argument(
        "--requests-per-second",
        type=positive_float,
        default=4.0,
        help="process-wide API request rate limit",
    )
    parser.add_argument(
        "--timeout",
        type=positive_float,
        default=30.0,
        help="timeout in seconds for each API request",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=5,
        help="retries after the initial attempt for each retryable API request",
    )
    parser.add_argument(
        "--limit",
        type=positive_int,
        help="process only the first N pending records (useful for a staged test)",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=Path(".karakeep-import-state.jsonl"),
        help="append-only completed-record log used to resume imports",
    )
    parser.add_argument(
        "--failure-file",
        type=Path,
        default=Path(".karakeep-import-errors.jsonl"),
        help="append-only failed-record log",
    )
    parser.add_argument(
        "--progress-every",
        type=positive_int,
        default=25,
        help="print progress after every N completed records",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.max_retries < 0:
        parser.error("--max-retries must not be negative")
    try:
        return run(args)
    except (ImportFailure, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
