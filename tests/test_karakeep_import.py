from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.response import addinfourl


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "karakeep-import.py"
IMPORTER_SPEC = importlib.util.spec_from_file_location(
    "karakeep_import", SCRIPT_PATH
)
if IMPORTER_SPEC is None or IMPORTER_SPEC.loader is None:
    raise RuntimeError(f"Could not load importer from {SCRIPT_PATH}")
importer = importlib.util.module_from_spec(IMPORTER_SPEC)
sys.modules[IMPORTER_SPEC.name] = importer
IMPORTER_SPEC.loader.exec_module(importer)


SAMPLE = {
    "id": "tweet-123",
    "tweetId": "123",
    "url": "https://x.com/example/status/123",
    "text": "A useful post\nwith details.",
    "authorName": "Example Person",
    "authorHandle": "example",
    "postedAt": "Wed Oct 11 14:08:46 +0000 2023",
    "bookmarkedAt": None,
    "links": ["https://example.com/article"],
    "mediaObjects": [{"type": "photo", "url": "https://pbs.twimg.com/a.jpg"}],
    "tags": ["Reading"],
}

CHROME_BOOKMARKS = """\
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><H3>Research &amp; Docs</H3>
        <DL><p>
            <DT><A HREF="view-source:https://example.com/docs?a=1&amp;b=2"
                ADD_DATE="1721779200">Example &amp; Documentation</A>
        </DL><p>
    </DL><p>
</DL><p>
"""


def tracked_text_files():
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=SCRIPT_PATH.parent,
        check=True,
        capture_output=True,
    )
    for relative_path in result.stdout.decode("utf-8").split("\0"):
        if not relative_path:
            continue
        path = SCRIPT_PATH.parent / relative_path
        try:
            yield relative_path, path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue


class FakeKarakeepHandler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, format, *args):
        pass

    def _json_body(self):
        size = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(size)) if size else None

    def _reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        type(self).requests.append(("GET", self.path, None))
        if self.path == "/api/v1/users/me":
            self._reply(200, {"id": "user-1", "name": "Tester"})
        else:
            self._reply(404, {"message": "not found"})

    def do_POST(self):
        body = self._json_body()
        type(self).requests.append(("POST", self.path, body))
        if self.path == "/api/v1/bookmarks":
            self._reply(201, {"id": "bookmark-1"})
        elif self.path == "/api/v1/bookmarks/bookmark-1/tags":
            self._reply(200, {"attached": ["tag-1"]})
        else:
            self._reply(404, {"message": "not found"})


class ReflectingApiErrorHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        raw = json.dumps(
            {"message": f"Rejected {self.headers.get('Authorization')}"}
        ).encode("utf-8")
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class ImporterTests(unittest.TestCase):
    def test_tracked_text_files_contain_no_personal_home_paths(self):
        personal_home = re.compile(
            r"(?:/(?:Users|home)/[A-Za-z0-9._-]+/|"
            r"[A-Za-z]:\\Users\\[^\\\s]+\\)"
        )
        violations = [
            relative_path
            for relative_path, content in tracked_text_files()
            if personal_home.search(content)
        ]

        self.assertEqual(violations, [])

    def test_tracked_karakeep_urls_use_reserved_example_hosts(self):
        violations = []
        for relative_path, content in tracked_text_files():
            for raw_url in re.findall(r"https?://[^\s`)'\"<>]+", content):
                hostname = urllib.parse.urlsplit(raw_url).hostname or ""
                if "karakeep" not in hostname.lower():
                    continue
                if hostname.endswith((".example", ".example.com")):
                    continue
                violations.append(relative_path)

        self.assertEqual(sorted(set(violations)), [])

    def test_default_server_uses_a_reserved_example_hostname(self):
        with patch.dict(os.environ, {}, clear=True):
            args = importer.build_parser().parse_args([])

        self.assertEqual(args.server, "https://karakeep.example.com")

    def test_dashboard_url_is_normalized_to_api_base(self):
        self.assertEqual(
            importer.normalize_api_base(
                "https://KARAKEEP.example:443/dashboard/bookmarks/"
            ),
            "https://karakeep.example/api/v1",
        )
        self.assertEqual(
            importer.normalize_api_base("https://karakeep.example/api/v1"),
            "https://karakeep.example/api/v1",
        )

    def test_payload_preserves_text_and_posted_timestamp(self):
        payload = importer.bookmark_payload(
            SAMPLE,
            include_title=True,
            include_note=True,
            timestamp_field="postedAt",
        )
        self.assertEqual(payload["type"], "link")
        self.assertEqual(payload["url"], SAMPLE["url"])
        self.assertEqual(payload["createdAt"], "2023-10-11T14:08:46Z")
        self.assertIn("A useful post", payload["note"])
        self.assertIn("Example Person (@example)", payload["title"])
        self.assertEqual(payload["crawlPriority"], "low")
        self.assertEqual(payload["source"], "import")

    def test_tags_are_deduplicated_case_insensitively(self):
        tags = importer.record_tags(
            SAMPLE,
            extra_tags=["Twitter", "custom"],
            include_default_tags=True,
            include_export_tags=True,
        )
        self.assertEqual(tags, ["twitter", "fieldtheory", "custom", "Reading"])

    def test_load_records_rejects_duplicate_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks.jsonl"
            duplicate = {**SAMPLE, "id": "other", "tweetId": "456"}
            path.write_text(
                json.dumps(SAMPLE) + "\n" + json.dumps(duplicate) + "\n",
                encoding="utf-8",
            )
            with self.assertRaises(importer.ImportFailure):
                importer.load_records(path)

    def test_preview_rejects_malformed_field_theory_bookmark_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks.jsonl"
            for url in (
                "https://",
                "https://:443/page",
                "https://" + "[::1/page",
                "https://example.com:invalid/page",
                "https://example.com/path with spaces",
            ):
                with self.subTest(url=url):
                    path.write_text(
                        json.dumps({**SAMPLE, "url": url}) + "\n", encoding="utf-8"
                    )
                    with (
                        redirect_stdout(io.StringIO()),
                        redirect_stderr(io.StringIO()) as errors,
                    ):
                        result = importer.main(["--input", str(path)])

                    self.assertEqual(result, 1)
                    self.assertIn("line 1 has no valid http(s) URL", errors.getvalue())

    def test_load_records_auto_detects_chrome_bookmarks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks.html"
            path.write_text(CHROME_BOOKMARKS, encoding="utf-8")

            records = importer.load_records(path)

        self.assertEqual(
            records,
            [
                {
                    "sourceType": "chrome",
                    "url": "https://example.com/docs?a=1&b=2",
                    "title": "Example & Documentation",
                    "addedAt": "1721779200",
                    "folders": ["Bookmarks bar", "Research & Docs"],
                    "tags": ["Bookmarks bar", "Research & Docs"],
                }
            ],
        )

    def test_chrome_payload_preserves_title_folder_and_added_timestamp(self):
        record = {
            "sourceType": "chrome",
            "url": "https://example.com/docs",
            "title": "Example Documentation",
            "addedAt": "1721779200",
            "folders": ["Bookmarks bar", "Research"],
            "tags": ["Bookmarks bar", "Research"],
        }

        payload = importer.bookmark_payload(
            record,
            include_title=True,
            include_note=True,
            timestamp_field="source",
        )

        self.assertEqual(payload["title"], "Example Documentation")
        self.assertEqual(payload["createdAt"], "2024-07-24T00:00:00Z")
        self.assertIn("Chrome folder: Bookmarks bar > Research", payload["note"])
        self.assertIn("Imported from Chrome bookmarks.", payload["note"])

    def test_chrome_tags_include_source_and_folders(self):
        tags = importer.record_tags(
            {
                "sourceType": "chrome",
                "tags": ["Bookmarks bar", "Research"],
            },
            extra_tags=["Custom"],
            include_default_tags=True,
            include_export_tags=True,
        )

        self.assertEqual(tags, ["chrome", "Custom", "Bookmarks bar", "Research"])

    def test_chrome_dry_run_reports_format_timestamp_and_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks-export"
            path.write_text(CHROME_BOOKMARKS, encoding="utf-8")
            output = io.StringIO()

            with redirect_stdout(output):
                result = importer.main(
                    [
                        "--input",
                        str(path),
                        "--input-format",
                        "chrome",
                        "--state-file",
                        str(Path(directory) / "state.jsonl"),
                    ]
                )

        self.assertEqual(result, 0)
        self.assertIn("Input format: Chrome bookmarks HTML", output.getvalue())
        self.assertIn(
            "Records with preserved source timestamp: 1", output.getvalue()
        )
        self.assertIn("Static tags: chrome", output.getvalue())

    def test_chrome_format_is_detected_from_header_without_html_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks-export"
            path.write_text(CHROME_BOOKMARKS, encoding="utf-8")
            output = io.StringIO()

            with redirect_stdout(output):
                result = importer.main(
                    [
                        "--input",
                        str(path),
                        "--state-file",
                        str(Path(directory) / "state.jsonl"),
                    ]
                )

        self.assertEqual(result, 0)
        self.assertIn("Input format: Chrome bookmarks HTML", output.getvalue())
        self.assertIn("Pending in this run: 1", output.getvalue())

    def test_chrome_urls_must_be_unique_after_view_source_normalization(self):
        duplicate_bookmarks = """\
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="https://example.com/docs">Documentation</A>
    <DT><A HREF="view-source:https://example.com/docs">Source</A>
</DL><p>
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks.html"
            path.write_text(duplicate_bookmarks, encoding="utf-8")
            error_output = io.StringIO()

            with redirect_stderr(error_output):
                result = importer.main(["--input", str(path)])

        self.assertEqual(result, 1)
        self.assertIn(
            "Duplicate URL https://example.com/docs in Chrome bookmark 2",
            error_output.getvalue(),
        )

    def test_chrome_import_rejects_non_web_bookmarks(self):
        bookmarklet_export = """\
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="javascript:document.body.remove()">Clean page</A>
</DL><p>
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks.html"
            path.write_text(bookmarklet_export, encoding="utf-8")
            error_output = io.StringIO()

            with redirect_stderr(error_output):
                result = importer.main(["--input", str(path)])

        self.assertEqual(result, 1)
        self.assertIn(
            "Chrome bookmark Clean page has no supported http(s) URL",
            error_output.getvalue(),
        )

    def test_chrome_export_is_imported_through_the_live_cli(self):
        FakeKarakeepHandler.requests = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeKarakeepHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                input_path = Path(directory) / "bookmarks.html"
                state_path = Path(directory) / "state.jsonl"
                failure_path = Path(directory) / "failures.jsonl"
                input_path.write_text(CHROME_BOOKMARKS, encoding="utf-8")

                with (
                    patch.dict(
                        os.environ,
                        {"CHROME_TEST_API_KEY": "test-key"},
                    ),
                    redirect_stdout(io.StringIO()),
                ):
                    result = importer.main(
                        [
                            "--input",
                            str(input_path),
                            "--execute",
                            "--api-key-env",
                            "CHROME_TEST_API_KEY",
                            "--server",
                            f"http://127.0.0.1:{server.server_port}",
                            "--workers",
                            "1",
                            "--requests-per-second",
                            "1000",
                            "--max-retries",
                            "0",
                            "--state-file",
                            str(state_path),
                            "--failure-file",
                            str(failure_path),
                        ]
                    )

                self.assertEqual(result, 0)
                self.assertEqual(
                    importer.StateStore(
                        state_path,
                        api_base=f"http://127.0.0.1:{server.server_port}/api/v1",
                        account_id="user-1",
                    ).completed_ids(),
                    {"https://example.com/docs?a=1&b=2"},
                )
                self.assertFalse(failure_path.exists())

            self.assertEqual(
                [(method, path) for method, path, _ in FakeKarakeepHandler.requests],
                [
                    ("GET", "/api/v1/users/me"),
                    ("POST", "/api/v1/bookmarks"),
                    ("POST", "/api/v1/bookmarks/bookmark-1/tags"),
                ],
            )
            bookmark_payload = FakeKarakeepHandler.requests[1][2]
            self.assertEqual(
                bookmark_payload,
                {
                    "type": "link",
                    "url": "https://example.com/docs?a=1&b=2",
                    "crawlPriority": "low",
                    "source": "import",
                    "title": "Example & Documentation",
                    "note": (
                        "Chrome folder: Bookmarks bar > Research & Docs\n"
                        "Added to Chrome: 2024-07-24T00:00:00Z\n"
                        "Imported from Chrome bookmarks."
                    ),
                    "createdAt": "2024-07-24T00:00:00Z",
                },
            )
            self.assertEqual(
                FakeKarakeepHandler.requests[2][2],
                {
                    "tags": [
                        {"tagName": "chrome", "attachedBy": "human"},
                        {"tagName": "Bookmarks bar", "attachedBy": "human"},
                        {"tagName": "Research & Docs", "attachedBy": "human"},
                    ]
                },
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_fieldtheory_dry_run_uses_source_timestamp_and_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bookmarks.jsonl"
            path.write_text(json.dumps(SAMPLE) + "\n", encoding="utf-8")
            state_path = Path(directory) / "state.jsonl"
            state_path.write_text(
                '{"sourceId":"123","status":"complete"}\n', encoding="utf-8"
            )
            output = io.StringIO()

            with patch.dict(os.environ, {}, clear=True), redirect_stdout(output):
                result = importer.main(
                    [
                        "--input",
                        str(path),
                        "--state-file",
                        str(state_path),
                    ]
                )

        self.assertEqual(result, 0)
        self.assertIn("Input format: Field Theory JSONL", output.getvalue())
        self.assertIn(
            "Pending in this run: 1 before the resume check", output.getvalue()
        )
        self.assertIn(
            "Records with preserved source timestamp: 1", output.getvalue()
        )
        self.assertIn("Static tags: twitter, fieldtheory", output.getvalue())

    def test_live_import_resumes_only_for_the_authenticated_destination(self):
        class ResumeHandler(FakeKarakeepHandler):
            requests = []

            def do_GET(self):
                self.requests.append(("GET", self.path, None))
                account = {
                    "Bearer original": "user-1",
                    "Bearer rotated": "user-1",
                    "Bearer other-account": "user-2",
                }.get(self.headers.get("Authorization"))
                self._reply(200, {"id": account} if account else {})

        with ExitStack() as stack:
            directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            servers = []
            for _ in range(2):
                server = stack.enter_context(
                    ThreadingHTTPServer(("127.0.0.1", 0), ResumeHandler)
                )
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                stack.callback(thread.join)
                stack.callback(server.shutdown)
                servers.append(f"http://127.0.0.1:{server.server_port}")
            first_base, second_base = servers

            input_path = directory / "bookmarks.jsonl"
            input_path.write_text(json.dumps(SAMPLE) + "\n", encoding="utf-8")
            state_path = directory / "state.jsonl"
            legacy_entry = '{"sourceId":"123","status":"complete"}\n'
            state_path.write_text(legacy_entry, encoding="utf-8")
            arguments = [
                "--execute",
                "--input", str(input_path),
                "--state-file", str(state_path),
                "--failure-file", str(directory / "failures.jsonl"),
                "--api-key-env", "RESUME_TEST_API_KEY",
                "--requests-per-second", "1000",
                "--max-retries", "0",
                "--no-default-tags", "--no-export-tags",
            ]
            for name, server_url, key, expected in (
                ("legacy history", first_base, "original", ["GET", "POST"]),
                ("rotated key", f"{first_base}/dashboard/", "rotated", ["GET"]),
                ("different account", first_base, "other-account", ["GET", "POST"]),
                ("different server", second_base, "original", ["GET", "POST"]),
                ("original destination still complete", first_base, "original", ["GET"]),
                ("missing account ID", first_base, "unknown", ["GET"]),
            ):
                with self.subTest(name=name):
                    ResumeHandler.requests.clear()
                    with (
                        patch.dict(os.environ, {"RESUME_TEST_API_KEY": key}),
                        redirect_stdout(io.StringIO()),
                        redirect_stderr(io.StringIO()) as errors,
                    ):
                        result = importer.main([*arguments, "--server", server_url])
                    if key == "unknown":
                        self.assertEqual(result, 1)
                        self.assertIn("account ID", errors.getvalue())
                    else:
                        self.assertEqual(result, 0, errors.getvalue())
                    self.assertEqual(
                        [method for method, _, _ in ResumeHandler.requests], expected
                    )
            self.assertTrue(
                state_path.read_text(encoding="utf-8").startswith(legacy_entry)
            )

    def test_live_import_stops_on_a_revoked_key_and_resumes_unfinished_records(self):
        class RevokedKeyHandler(FakeKarakeepHandler):
            requests = []

            def do_POST(self):
                body = self._json_body()
                self.requests.append(("POST", self.path, body))
                if (
                    self.headers.get("Authorization") == "Bearer revoked"
                    and body["url"] != "https://example.com/bookmark/1"
                ):
                    self._reply(401, {"message": "Unauthorized"})
                else:
                    self._reply(201, {"id": "bookmark-1"})

        with ExitStack() as stack:
            directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            server = stack.enter_context(
                ThreadingHTTPServer(("127.0.0.1", 0), RevokedKeyHandler)
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            stack.callback(thread.join)
            stack.callback(server.shutdown)
            urls = [f"https://example.com/bookmark/{index}" for index in range(1, 4)]
            input_path = directory / "bookmarks.jsonl"
            input_path.write_text(
                "".join(
                    json.dumps({"id": str(index), "url": url}) + "\n"
                    for index, url in enumerate(urls, start=1)
                ),
                encoding="utf-8",
            )
            failure_path = directory / "failures.jsonl"
            arguments = [
                "--execute",
                "--input", str(input_path),
                "--state-file", str(directory / "state.jsonl"),
                "--failure-file", str(failure_path),
                "--server", f"http://127.0.0.1:{server.server_port}",
                "--api-key-env", "REVOCATION_TEST_API_KEY",
                "--workers", "1",
                "--requests-per-second", "1000",
                "--no-default-tags",
            ]
            with (
                patch.dict(os.environ, {"REVOCATION_TEST_API_KEY": "revoked"}),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()) as errors,
            ):
                self.assertEqual(importer.main(arguments), 1)
            self.assertEqual(
                [
                    body["url"]
                    for method, _, body in RevokedKeyHandler.requests
                    if method == "POST"
                ],
                urls[:2],
            )
            self.assertIn("rejected the API key", errors.getvalue())
            failures = failure_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual([json.loads(line)["url"] for line in failures], [urls[1]])

            RevokedKeyHandler.requests.clear()
            with (
                patch.dict(os.environ, {"REVOCATION_TEST_API_KEY": "replacement"}),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()) as errors,
            ):
                self.assertEqual(importer.main(arguments), 0, errors.getvalue())
            self.assertEqual(
                [
                    body["url"]
                    for method, _, body in RevokedKeyHandler.requests
                    if method == "POST"
                ],
                urls[1:],
            )

    def test_import_creates_bookmark_attaches_tags_and_writes_state(self):
        FakeKarakeepHandler.requests = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeKarakeepHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                errors = importer.JsonlLog(Path(directory) / "errors.jsonl")
                client = importer.KarakeepClient(
                    f"http://127.0.0.1:{server.server_port}",
                    "test-key",
                    requests_per_second=1000,
                    max_retries=0,
                )
                account_id = client.preflight()["id"]
                self.assertEqual(account_id, "user-1")
                state = importer.StateStore(
                    Path(directory) / "state.jsonl",
                    api_base=client.api_base,
                    account_id=account_id,
                )
                result = importer.import_one(
                    SAMPLE,
                    client=client,
                    state=state,
                    errors=errors,
                    extra_tags=[],
                    include_default_tags=True,
                    include_export_tags=True,
                    include_title=True,
                    include_note=True,
                    timestamp_field="postedAt",
                )
                self.assertEqual(result.outcome, "created")
                self.assertEqual(state.completed_ids(), {"123"})
                self.assertFalse(errors.path.exists())

            methods_and_paths = [
                (method, path) for method, path, _ in FakeKarakeepHandler.requests
            ]
            self.assertEqual(
                methods_and_paths,
                [
                    ("GET", "/api/v1/users/me"),
                    ("POST", "/api/v1/bookmarks"),
                    ("POST", "/api/v1/bookmarks/bookmark-1/tags"),
                ],
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_api_failure_redacts_the_key_at_the_client_boundary(self):
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), ReflectingApiErrorHandler
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        secret = "cli-secret-must-never-reach-a-log"
        try:
            client = importer.KarakeepClient(
                f"http://127.0.0.1:{server.server_port}",
                secret,
                requests_per_second=1000,
                max_retries=0,
            )

            with self.assertRaises(importer.ApiFailure) as raised:
                client.create_bookmark({"type": "link", "url": SAMPLE["url"]})

            message = str(raised.exception)
            self.assertNotIn(secret, message)
            self.assertIn("[REDACTED]", message)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_preflight_follows_only_same_origin_redirects(self):
        server = "http://bookmarks.example"
        for location, same_origin in (
            ("/identity", True),
            ("http://BOOKMARKS.EXAMPLE:80/identity", True),
            ("http://archive.example/identity", False),
            ("http://bookmarks.example:8080/identity", False),
            ("https://bookmarks.example/identity", False),
            ("http://reader@bookmarks.example/identity", False),
        ):
            with self.subTest(location=location):
                def open_request(_handler, request):
                    headers = Message()
                    if request.full_url == f"{server}/api/v1/users/me":
                        headers["Location"] = location
                        response = addinfourl(
                            io.BytesIO(), headers, request.full_url, 302
                        )
                        response.msg = "Found"
                    else:
                        self.assertTrue(
                            same_origin, "request left its configured origin"
                        )
                        self.assertEqual(
                            request.get_header("Authorization"), "Bearer fixture"
                        )
                        response = addinfourl(
                            io.BytesIO(b'{"id": "reader"}'), headers, request.full_url, 200
                        )
                        response.msg = "OK"
                    return response

                with (
                    patch.object(urllib.request.HTTPHandler, "http_open", open_request),
                    patch.object(urllib.request.HTTPSHandler, "https_open", open_request),
                ):
                    client = importer.KarakeepClient(server, "fixture", max_retries=0)
                    if same_origin:
                        self.assertEqual(client.preflight()["id"], "reader")
                    else:
                        with self.assertRaises(importer.ApiFailure) as raised:
                            client.preflight()
                        self.assertEqual(raised.exception.status, 302)


if __name__ == "__main__":
    unittest.main()
