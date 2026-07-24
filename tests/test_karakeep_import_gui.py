from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TextIO, cast
from unittest.mock import patch

from tests.test_karakeep_import import FakeKarakeepHandler


GUI_SCRIPT_PATH = Path(__file__).resolve().parents[1] / "karakeep-import-gui.py"
CHROME_BOOKMARKS = """\
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Research</H3>
  <DL><p>
    <DT><A HREF="https://example.com/docs" ADD_DATE="1721779200">Docs</A>
  </DL><p>
</DL><p>
"""
FIELD_THEORY_BOOKMARK = (
    json.dumps(
        {
            "id": "tweet-123",
            "tweetId": "123",
            "url": "https://x.com/example/status/123",
            "text": "A useful post.",
            "authorName": "Example Person",
            "authorHandle": "example",
            "postedAt": "Wed Oct 11 14:08:46 +0000 2023",
            "tags": ["Reading"],
        }
    )
    + "\n"
)


def load_gui_module():
    spec = importlib.util.spec_from_file_location(
        "karakeep_import_gui", GUI_SCRIPT_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load GUI from {GUI_SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def get_run_token(server) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/") as response:
        page = response.read().decode("utf-8")
    match = re.search(
        r'<meta name="run-token" content="([^"]+)">',
        page,
    )
    if match is None:
        raise AssertionError("The GUI page has no run token")
    return match.group(1)


@contextmanager
def running(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def make_payload(directory: str, **overrides):
    payload = {
        "inputName": "bookmarks.html",
        "inputContent": CHROME_BOOKMARKS,
        "inputPath": "",
        "inputFormat": "auto",
        "server": "https://karakeep.example/dashboard",
        "apiKeyEnv": "KARAKEEP_API_KEY",
        "apiKey": "",
        "tags": ["Reading"],
        "includeDefaultTags": True,
        "includeExportTags": True,
        "includeTitles": True,
        "includeNotes": True,
        "timestampField": "source",
        "workers": 1,
        "requestsPerSecond": 1000,
        "timeout": 5,
        "maxRetries": 0,
        "limit": None,
        "stateFile": str(Path(directory) / "state.jsonl"),
        "failureFile": str(Path(directory) / "failures.jsonl"),
        "progressEvery": 1,
        "execute": False,
    }
    payload.update(overrides)
    return payload


def post_run(server, payload):
    request = urllib.request.Request(
        f"http://127.0.0.1:{server.server_port}/api/run",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-Karakeep-GUI-Token": get_run_token(server),
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        events = [
            json.loads(line) for line in response.read().decode("utf-8").splitlines()
        ]
    return response.status, events


def output_text(events) -> str:
    return "".join(event["text"] for event in events if event["type"] == "output")


class ReflectingKarakeepHandler(BaseHTTPRequestHandler):
    fail_preflight = False

    def log_message(self, format, *args):
        pass

    def _reply(self, status, body):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if type(self).fail_preflight:
            self._reply(
                401,
                {"message": f"Rejected {self.headers.get('Authorization')}"},
            )
        else:
            self._reply(200, {"id": "user-1"})

    def do_POST(self):
        self._reply(
            400,
            {"message": f"Rejected {self.headers.get('Authorization')}"},
        )


class GuiAcceptanceTests(unittest.TestCase):
    def test_root_page_exposes_import_form_with_preview_as_safe_default(self):
        self.assertTrue(
            GUI_SCRIPT_PATH.exists(),
            "The cross-platform GUI entry point does not exist yet",
        )
        gui = load_gui_module()
        with running(gui.create_server(port=0)) as server:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/"
            ) as response:
                page = response.read().decode("utf-8")

            self.assertEqual(response.status, 200)
            self.assertIn("<title>Karakeep Importer</title>", page)
            self.assertIn('id="import-form"', page)
            self.assertIn('id="preview-button"', page)
            self.assertIn("Preview is always safe", page)

    def test_import_form_represents_every_cli_option(self):
        gui = load_gui_module()
        with running(gui.create_server(port=0)) as server:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/"
            ) as response:
                page = response.read().decode("utf-8")

            control_ids = (
                "input-file",
                "input-path",
                "input-format",
                "server",
                "api-key-env",
                "extra-tags",
                "include-default-tags",
                "include-export-tags",
                "include-titles",
                "include-notes",
                "timestamp-field",
                "workers",
                "requests-per-second",
                "timeout",
                "max-retries",
                "limit",
                "state-file",
                "failure-file",
                "progress-every",
            )
            missing_controls = [
                control_id
                for control_id in control_ids
                if f'id="{control_id}"' not in page
            ]
            self.assertEqual(missing_controls, [])
            self.assertIn('id="workers" type="number" value="4"', page)
            self.assertIn(
                'id="requests-per-second" type="number" value="4.0"',
                page,
            )
            self.assertIn('id="timeout" type="number" value="30.0"', page)
            self.assertIn('id="max-retries" type="number" value="5"', page)
            self.assertIn(
                'id="progress-every" type="number" value="25"',
                page,
            )

    def test_fieldset_legends_render_at_one_and_a_half_times_base_font_size(self):
        gui = load_gui_module()
        with running(gui.create_server(port=0)) as server:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/"
            ) as response:
                page = response.read().decode("utf-8")

            self.assertRegex(
                page,
                r"legend \{[^}]*font-size: 1\.5rem;",
            )

    def test_preview_streams_the_real_cli_summary_without_contacting_karakeep(
        self,
    ):
        gui = load_gui_module()
        with (
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
        ):
            payload = make_payload(directory)
            status, events = post_run(server, payload)
            output = output_text(events)

            self.assertEqual(status, 200)
            self.assertEqual(events[-1], {"type": "complete", "exitCode": 0})
            self.assertIn("Dry run only", output)
            self.assertIn("Input format: Chrome bookmarks HTML", output)
            self.assertIn("Pending in this run: 1", output)
            self.assertIn("Static tags: chrome, Reading", output)
            self.assertIn("Target API: https://karakeep.example/api/v1", output)
            self.assertFalse(Path(payload["stateFile"]).exists())
            self.assertFalse(Path(payload["failureFile"]).exists())

    def test_preview_accepts_a_field_theory_jsonl_upload(self):
        gui = load_gui_module()
        with (
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
        ):
            payload = make_payload(
                directory,
                inputName="bookmarks.jsonl",
                inputContent=FIELD_THEORY_BOOKMARK,
            )
            _, events = post_run(server, payload)
            output = output_text(events)

            self.assertEqual(events[-1], {"type": "complete", "exitCode": 0})
            self.assertIn("Input format: Field Theory JSONL", output)
            self.assertIn("Pending in this run: 1", output)

    def test_invalid_upload_reports_the_cli_error_without_writing_logs(self):
        gui = load_gui_module()
        with (
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
        ):
            payload = make_payload(
                directory,
                inputName="bookmarks.jsonl",
                inputContent="{not-json}\n",
            )
            _, events = post_run(server, payload)
            output = output_text(events)

            self.assertEqual(events[-1], {"type": "complete", "exitCode": 1})
            self.assertIn("Invalid JSON", output)
            self.assertFalse(Path(payload["stateFile"]).exists())
            self.assertFalse(Path(payload["failureFile"]).exists())

    def test_launcher_prints_a_reachable_loopback_url(self):
        process = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(GUI_SCRIPT_PATH),
                "--no-browser",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        stdout = cast(TextIO, process.stdout)
        stderr = cast(TextIO, process.stderr)
        try:
            url = stdout.readline().strip()
            self.assertRegex(url, r"^http://127\.0\.0\.1:\d+/$")
            with urllib.request.urlopen(url) as response:
                page = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertIn("<title>Karakeep Importer</title>", page)
        finally:
            process.terminate()
            process.wait(timeout=5)
            stdout.close()
            stderr.close()

    def test_page_exposes_accessible_status_and_streamed_output_regions(self):
        gui = load_gui_module()
        with running(gui.create_server(port=0)) as server:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/"
            ) as response:
                page = response.read().decode("utf-8")

            self.assertIn('id="run-status" role="status" aria-live="polite"', page)
            self.assertIn('id="output" role="log" aria-live="polite"', page)

    def test_page_confirms_live_import_with_an_accessible_dialog(self):
        gui = load_gui_module()
        with running(gui.create_server(port=0)) as server:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/"
            ) as response:
                page = response.read().decode("utf-8")

            self.assertIn('id="api-key" type="password" autocomplete="off"', page)
            self.assertIn('id="execute-button" type="button">Import live', page)
            self.assertIn("<dialog", page)
            self.assertIn('id="execute-dialog"', page)
            self.assertIn('aria-labelledby="execute-dialog-title"', page)
            self.assertIn(
                'aria-describedby="execute-dialog-description"',
                page,
            )
            self.assertIn('id="execute-dialog-description"', page)
            self.assertIn('id="cancel-execute-button"', page)
            self.assertIn('id="confirm-execute-button"', page)
            self.assertIn(
                "This will send pending bookmarks to Karakeep. Continue?",
                page,
            )
            self.assertIn("executeDialog.showModal()", page)
            self.assertNotIn("window.confirm", page)

    def test_live_import_uses_child_environment_and_streams_completion(self):
        gui = load_gui_module()
        FakeKarakeepHandler.requests = []
        karakeep = ThreadingHTTPServer(("127.0.0.1", 0), FakeKarakeepHandler)
        secret = "gui-only-secret-value"
        with (
            running(karakeep),
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
        ):
            log_directory = Path(directory) / "logs with spaces"
            state_file = log_directory / "state.jsonl"
            failure_file = log_directory / "failures.jsonl"
            payload = make_payload(
                directory,
                server=f"http://127.0.0.1:{karakeep.server_port}",
                apiKeyEnv="GUI_TEST_KARAKEEP_API_KEY",
                apiKey=secret,
                stateFile=str(state_file),
                failureFile=str(failure_file),
                execute=True,
            )
            _, events = post_run(server, payload)

            output = output_text(events)
            completed = [
                json.loads(line)
                for line in state_file.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(events[-1], {"type": "complete", "exitCode": 0})
            self.assertIn("Authenticated. Importing 1 record(s)", output)
            self.assertIn("Progress: 1/1 (0 failed)", output)
            self.assertIn(
                "Finished: 1 created, 0 already existed, 0 failed.",
                output,
            )
            self.assertEqual(completed[0]["status"], "complete")
            self.assertFalse(failure_file.exists())
            self.assertNotIn(secret, json.dumps(events))
            self.assertEqual(
                [(method, path) for method, path, _ in FakeKarakeepHandler.requests],
                [
                    ("GET", "/api/v1/users/me"),
                    ("POST", "/api/v1/bookmarks"),
                    ("POST", "/api/v1/bookmarks/bookmark-1/tags"),
                ],
            )

    def test_uploaded_failure_filename_cannot_collide_with_the_failure_log(self):
        gui = load_gui_module()
        FakeKarakeepHandler.requests = []
        karakeep = ThreadingHTTPServer(("127.0.0.1", 0), FakeKarakeepHandler)
        with (
            running(karakeep),
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
        ):
            payload = make_payload(
                directory,
                inputName="failures.jsonl",
                inputContent=FIELD_THEORY_BOOKMARK,
                server=f"http://127.0.0.1:{karakeep.server_port}",
                apiKeyEnv="GUI_COLLISION_KARAKEEP_API_KEY",
                apiKey="collision-test-secret",
                execute=True,
            )
            _, events = post_run(server, payload)

            self.assertEqual(events[-1], {"type": "complete", "exitCode": 0})
            self.assertFalse(Path(payload["failureFile"]).exists())

    def test_run_endpoint_rejects_requests_without_the_gui_token(self):
        gui = load_gui_module()
        with running(gui.create_server(port=0)) as server:
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/run",
                data=b"{}",
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request)
            try:
                self.assertEqual(raised.exception.code, 403)
            finally:
                raised.exception.close()

    def test_cross_platform_support_is_documented_and_checked_in_ci(self):
        repository = Path(__file__).resolve().parents[1]
        workflow_path = repository / ".github" / "workflows" / "test.yml"
        self.assertTrue(workflow_path.exists())
        workflow = workflow_path.read_text(encoding="utf-8")
        readme = (repository / "README.md").read_text(encoding="utf-8")

        missing_workflow_contracts = [
            contract
            for contract in (
                "ubuntu-latest",
                "windows-latest",
                "macos-latest",
                '"3.10"',
                '"3.14"',
                "python -m unittest discover -s tests -v",
                "python -m compileall -q",
            )
            if contract not in workflow
        ]
        missing_documentation = [
            contract
            for contract in (
                "## Use the graphical interface",
                "python3 karakeep-import-gui.py",
                "py karakeep-import-gui.py",
                "127.0.0.1",
                "not persisted",
            )
            if contract not in readme
        ]
        self.assertEqual(missing_workflow_contracts, [])
        self.assertEqual(missing_documentation, [])

    def test_inherited_api_key_is_redacted_from_preflight_failure_output(self):
        gui = load_gui_module()
        secret = "inherited-key-must-not-leak"
        environment_name = "GUI_INHERITED_KARAKEEP_KEY"
        ReflectingKarakeepHandler.fail_preflight = True
        karakeep = ThreadingHTTPServer(("127.0.0.1", 0), ReflectingKarakeepHandler)
        with (
            running(karakeep),
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {environment_name: secret}),
        ):
            payload = make_payload(
                directory,
                server=f"http://127.0.0.1:{karakeep.server_port}",
                apiKeyEnv=environment_name,
                execute=True,
            )
            _, events = post_run(server, payload)

        rendered_events = json.dumps(events)
        self.assertEqual(events[-1], {"type": "complete", "exitCode": 1})
        self.assertNotIn(secret, rendered_events)
        self.assertIn("[REDACTED]", rendered_events)

    def test_api_key_is_redacted_before_failure_log_is_appended(self):
        gui = load_gui_module()
        secret = "persisted-key-must-not-leak"
        environment_name = "GUI_FAILURE_KARAKEEP_KEY"
        ReflectingKarakeepHandler.fail_preflight = False
        karakeep = ThreadingHTTPServer(("127.0.0.1", 0), ReflectingKarakeepHandler)
        with (
            running(karakeep),
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
            patch.dict(os.environ, {environment_name: secret}),
        ):
            payload = make_payload(
                directory,
                server=f"http://127.0.0.1:{karakeep.server_port}",
                apiKeyEnv=environment_name,
                execute=True,
            )
            _, events = post_run(server, payload)
            failure_log = Path(payload["failureFile"]).read_text(encoding="utf-8")

        self.assertEqual(events[-1], {"type": "complete", "exitCode": 1})
        self.assertNotIn(secret, failure_log)
        self.assertIn("[REDACTED]", failure_log)

    def test_process_launch_error_returns_an_explicit_http_failure(self):
        gui = load_gui_module()
        secret = "launch-error-secret"
        with (
            running(gui.create_server(port=0)) as server,
            tempfile.TemporaryDirectory() as directory,
        ):
            payload = make_payload(
                directory,
                apiKeyEnv="INVALID=ENVIRONMENT",
                apiKey=secret,
            )
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/run",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "X-Karakeep-GUI-Token": get_run_token(server),
                },
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request)
            try:
                response_body = raised.exception.read().decode("utf-8")
                self.assertEqual(raised.exception.code, 400)
                self.assertIn("Could not start importer", response_body)
                self.assertNotIn(secret, response_body)
            finally:
                raised.exception.close()


if __name__ == "__main__":
    unittest.main()
