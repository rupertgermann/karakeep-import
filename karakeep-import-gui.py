#!/usr/bin/env python3
"""Local browser interface for the Karakeep bookmark importer."""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
import secrets
import subprocess
import sys
import tempfile
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping, TextIO, cast


IMPORTER_PATH = Path(__file__).with_name("karakeep-import.py")


def load_importer():
    module_name = "_karakeep_import_cli"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, IMPORTER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load importer from {IMPORTER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def render_page(defaults: argparse.Namespace, run_token: str) -> str:
    input_path = html.escape(str(defaults.input), quote=True)
    server = html.escape(defaults.server, quote=True)
    api_key_env = html.escape(defaults.api_key_env, quote=True)
    state_file = html.escape(str(defaults.state_file), quote=True)
    failure_file = html.escape(str(defaults.failure_file), quote=True)
    escaped_run_token = html.escape(run_token, quote=True)
    return f"""\
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="run-token" content="{escaped_run_token}">
  <title>Karakeep Importer</title>
  <style>
    :root {{
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
      color: #17202a;
      background: #eef2f5;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; }}
    main {{
      width: min(100% - 2rem, 64rem);
      margin: 0 auto;
      padding: 3rem 0 5rem;
    }}
    h1 {{ margin-bottom: .4rem; font-size: clamp(2rem, 5vw, 3.5rem); }}
    .intro {{ color: #4b5966; margin: 0 0 2rem; }}
    form {{ display: grid; gap: 1rem; }}
    fieldset, .run-panel {{
      margin: 0;
      padding: 1.25rem;
      border: 1px solid #cfdae3;
      border-radius: .9rem;
      background: #fff;
      box-shadow: 0 .4rem 1.4rem rgb(30 55 75 / 8%);
    }}
    legend {{ padding: 0 .35rem; font-size: 1.5rem; font-weight: 700; }}
    .field-grid {{
      display: grid;
      grid-template-columns: minmax(10rem, .7fr) minmax(12rem, 1.3fr);
      align-items: center;
      gap: .8rem 1rem;
    }}
    label {{ font-weight: 600; }}
    label:has(input[type="checkbox"]) {{ grid-column: 1 / -1; }}
    input, select, textarea, button {{
      width: 100%;
      min-height: 2.75rem;
      border: 1px solid #aebdca;
      border-radius: .55rem;
      padding: .65rem .75rem;
      font: inherit;
    }}
    input[type="checkbox"] {{
      width: 1.1rem;
      min-height: auto;
      margin: 0 .45rem 0 0;
      accent-color: #095fab;
    }}
    textarea {{ min-height: 5rem; resize: vertical; }}
    .actions {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }}
    button {{
      border: 0;
      background: #095fab;
      color: #fff;
      font-weight: 750;
      cursor: pointer;
    }}
    button:hover {{ background: #074b86; }}
    #execute-button {{ background: #a42a2a; }}
    #execute-button:hover {{ background: #7e2020; }}
    button:disabled {{ cursor: wait; opacity: .65; }}
    input:focus-visible, select:focus-visible, textarea:focus-visible,
    button:focus-visible {{
      outline: 3px solid #f5a623;
      outline-offset: 2px;
    }}
    dialog {{
      width: min(calc(100% - 2rem), 30rem);
      border: 0;
      border-radius: .9rem;
      padding: 0;
      color: #17202a;
      box-shadow: 0 1.5rem 4rem rgb(16 24 32 / 35%);
    }}
    dialog::backdrop {{ background: rgb(16 24 32 / 68%); }}
    .dialog-content {{ margin: 0; padding: 1.5rem; }}
    .dialog-content h2 {{ margin: 0 0 .6rem; }}
    .dialog-content p {{ margin: 0 0 1.25rem; color: #4b5966; }}
    .dialog-actions {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .75rem;
    }}
    #cancel-execute-button {{ background: #e5edf3; color: #17202a; }}
    #cancel-execute-button:hover {{ background: #d4e0e9; }}
    #confirm-execute-button {{ background: #a42a2a; }}
    #confirm-execute-button:hover {{ background: #7e2020; }}
    .run-panel {{ margin-top: 1rem; background: #101820; color: #edf5fa; }}
    .run-panel h2 {{ margin-top: 0; }}
    #run-status {{ color: #9fd3f5; font-weight: 700; }}
    #output {{
      min-height: 10rem;
      max-height: 28rem;
      margin: 0;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: .9rem/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
    }}
    @media (max-width: 42rem) {{
      main {{ width: min(100% - 1rem, 64rem); padding-top: 1.5rem; }}
      .field-grid {{ grid-template-columns: 1fr; }}
      .actions {{ grid-template-columns: 1fr; }}
      label:has(input[type="checkbox"]) {{ grid-column: auto; }}
    }}
  </style>
</head>
<body>
  <main>
    <h1>Karakeep Importer</h1>
    <p class="intro">Preview is always safe: no data is sent to Karakeep.</p>
    <form id="import-form">
      <fieldset>
        <legend>Bookmark export</legend>
        <div class="field-grid">
          <label for="input-file">Choose an export</label>
          <input id="input-file" type="file" accept=".json,.jsonl,.html,.htm">
          <label for="input-path">Or use a local path</label>
          <input id="input-path" type="text" value="{input_path}">
          <label for="input-format">Input format</label>
          <select id="input-format">
            <option value="auto" selected>Auto detect</option>
            <option value="fieldtheory">Field Theory JSONL</option>
            <option value="chrome">Chrome bookmarks HTML</option>
          </select>
        </div>
      </fieldset>

      <fieldset>
        <legend>Karakeep</legend>
        <div class="field-grid">
          <label for="server">Server</label>
          <input id="server" type="url" value="{server}" required>
          <label for="api-key-env">API key environment variable</label>
          <input id="api-key-env" type="text" value="{api_key_env}" required>
          <label for="api-key">API key for this run</label>
          <input id="api-key" type="password" autocomplete="off">
        </div>
      </fieldset>

      <fieldset>
        <legend>Bookmark metadata</legend>
        <div class="field-grid">
          <label for="extra-tags">Extra tags, one per line</label>
          <textarea id="extra-tags"></textarea>
          <label>
            <input id="include-default-tags" type="checkbox" checked>
            Include source tags
          </label>
          <label>
            <input id="include-export-tags" type="checkbox" checked>
            Include export tags and folders
          </label>
          <label>
            <input id="include-titles" type="checkbox" checked>
            Preserve titles
          </label>
          <label>
            <input id="include-notes" type="checkbox" checked>
            Preserve notes
          </label>
          <label for="timestamp-field">Timestamp</label>
          <select id="timestamp-field">
            <option value="source" selected>Source timestamp</option>
            <option value="postedAt">postedAt</option>
            <option value="bookmarkedAt">bookmarkedAt</option>
            <option value="addedAt">addedAt</option>
            <option value="none">Do not preserve</option>
          </select>
        </div>
      </fieldset>

      <fieldset>
        <legend>Execution</legend>
        <div class="field-grid">
          <label for="workers">Workers</label>
          <input id="workers" type="number" value="{defaults.workers}" min="1">
          <label for="requests-per-second">Requests per second</label>
          <input id="requests-per-second" type="number" value="{defaults.requests_per_second}" min="0.01" step="any">
          <label for="timeout">Request timeout in seconds</label>
          <input id="timeout" type="number" value="{defaults.timeout}" min="0.01" step="any">
          <label for="max-retries">Maximum retries</label>
          <input id="max-retries" type="number" value="{defaults.max_retries}" min="0">
          <label for="limit">Record limit</label>
          <input id="limit" type="number" min="1">
          <label for="state-file">State log</label>
          <input id="state-file" type="text" value="{state_file}" required>
          <label for="failure-file">Failure log</label>
          <input id="failure-file" type="text" value="{failure_file}" required>
          <label for="progress-every">Progress frequency</label>
          <input id="progress-every" type="number" value="{defaults.progress_every}" min="1">
        </div>
      </fieldset>

      <div class="actions">
        <button id="preview-button" type="submit">Preview import</button>
        <button id="execute-button" type="button">Import live</button>
      </div>
    </form>
    <dialog
      id="execute-dialog"
      aria-labelledby="execute-dialog-title"
      aria-describedby="execute-dialog-description"
    >
      <form class="dialog-content" method="dialog">
        <h2 id="execute-dialog-title">Import bookmarks live?</h2>
        <p id="execute-dialog-description">
          This will send pending bookmarks to Karakeep. Continue?
        </p>
        <div class="dialog-actions">
          <button
            id="cancel-execute-button"
            type="submit"
            value="cancel"
            autofocus
          >Cancel</button>
          <button
            id="confirm-execute-button"
            type="submit"
            value="confirm"
          >Import live</button>
        </div>
      </form>
    </dialog>
    <section class="run-panel" aria-labelledby="output-heading">
      <h2 id="output-heading">Run output</h2>
      <p id="run-status" role="status" aria-live="polite">Ready to preview.</p>
      <pre id="output" role="log" aria-live="polite" tabindex="0"></pre>
    </section>
  </main>
  <script>
    const form = document.getElementById("import-form");
    const runToken = document.querySelector(
      'meta[name="run-token"]'
    ).content;
    const previewButton = document.getElementById("preview-button");
    const executeButton = document.getElementById("execute-button");
    const executeDialog = document.getElementById("execute-dialog");
    const status = document.getElementById("run-status");
    const output = document.getElementById("output");

    function value(id) {{
      return document.getElementById(id).value;
    }}

    function numberValue(id) {{
      const raw = value(id);
      return raw === "" ? null : Number(raw);
    }}

    function checked(id) {{
      return document.getElementById(id).checked;
    }}

    function setBusy(busy, execute) {{
      for (const control of form.elements) {{
        control.disabled = busy;
      }}
      previewButton.textContent = busy && !execute
        ? "Previewing…"
        : "Preview import";
      executeButton.textContent = busy && execute
        ? "Importing…"
        : "Import live";
    }}

    async function requestPayload(execute) {{
      const selectedFile = document.getElementById("input-file").files[0];
      return {{
        inputName: selectedFile ? selectedFile.name : null,
        inputContent: selectedFile ? await selectedFile.text() : null,
        inputPath: value("input-path"),
        inputFormat: value("input-format"),
        server: value("server"),
        apiKeyEnv: value("api-key-env"),
        apiKey: value("api-key"),
        tags: value("extra-tags").split("\\n").map(
          (tag) => tag.trim()
        ).filter(Boolean),
        includeDefaultTags: checked("include-default-tags"),
        includeExportTags: checked("include-export-tags"),
        includeTitles: checked("include-titles"),
        includeNotes: checked("include-notes"),
        timestampField: value("timestamp-field"),
        workers: numberValue("workers"),
        requestsPerSecond: numberValue("requests-per-second"),
        timeout: numberValue("timeout"),
        maxRetries: numberValue("max-retries"),
        limit: numberValue("limit"),
        stateFile: value("state-file"),
        failureFile: value("failure-file"),
        progressEvery: numberValue("progress-every"),
        execute
      }};
    }}

    function handleEvent(event, execute) {{
      if (event.type === "output") {{
        output.textContent += event.text;
        output.scrollTop = output.scrollHeight;
      }}
      if (event.type === "complete") {{
        const action = execute ? "Import" : "Preview";
        status.textContent = event.exitCode === 0
          ? action + " complete."
          : action + " failed with exit code " + event.exitCode + ".";
      }}
    }}

    async function run(execute) {{
      if (!form.reportValidity()) return;
      setBusy(true, execute);
      output.textContent = "";
      status.textContent = execute
        ? "Preparing live import…"
        : "Preparing preview…";
      try {{
        const response = await fetch("/api/run", {{
          method: "POST",
          headers: {{
            "Content-Type": "application/json",
            "X-Karakeep-GUI-Token": runToken
          }},
          body: JSON.stringify(await requestPayload(execute))
        }});
        if (!response.ok || !response.body) {{
          throw new Error(await response.text() || "Run could not start.");
        }}
        status.textContent = execute ? "Import running…" : "Preview running…";
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (true) {{
          const result = await reader.read();
          buffered += decoder.decode(result.value || new Uint8Array(), {{
            stream: !result.done
          }});
          const lines = buffered.split("\\n");
          buffered = lines.pop() || "";
          for (const line of lines) {{
            if (line) handleEvent(JSON.parse(line), execute);
          }}
          if (result.done) break;
        }}
        if (buffered) handleEvent(JSON.parse(buffered), execute);
      }} catch (error) {{
        status.textContent = execute ? "Import failed." : "Preview failed.";
        output.textContent += String(error) + "\\n";
      }} finally {{
        setBusy(false, execute);
      }}
    }}

    form.addEventListener("submit", async (event) => {{
      event.preventDefault();
      await run(false);
    }});

    executeButton.addEventListener("click", () => {{
      if (!form.reportValidity()) return;
      executeDialog.returnValue = "";
      executeDialog.showModal();
    }});

    executeDialog.addEventListener("close", async () => {{
      if (executeDialog.returnValue !== "confirm") return;
      await run(true);
    }});
  </script>
</body>
</html>
"""


def importer_command(
    payload: Mapping[str, Any],
    input_path: Path,
) -> list[str]:
    command = [
        sys.executable,
        "-u",
        str(IMPORTER_PATH),
        "--input",
        str(input_path),
        "--input-format",
        str(payload["inputFormat"]),
        "--server",
        str(payload["server"]),
        "--api-key-env",
        str(payload["apiKeyEnv"]),
        "--timestamp-field",
        str(payload["timestampField"]),
        "--workers",
        str(payload["workers"]),
        "--requests-per-second",
        str(payload["requestsPerSecond"]),
        "--timeout",
        str(payload["timeout"]),
        "--max-retries",
        str(payload["maxRetries"]),
        "--state-file",
        str(payload["stateFile"]),
        "--failure-file",
        str(payload["failureFile"]),
        "--progress-every",
        str(payload["progressEvery"]),
    ]
    for tag in payload.get("tags", []):
        command.extend(("--tag", str(tag)))
    if not payload.get("includeDefaultTags", True):
        command.append("--no-default-tags")
    if not payload.get("includeExportTags", True):
        command.append("--no-export-tags")
    if not payload.get("includeTitles", True):
        command.append("--no-titles")
    if not payload.get("includeNotes", True):
        command.append("--no-notes")
    if payload.get("limit") not in (None, ""):
        command.extend(("--limit", str(payload["limit"])))
    if payload.get("execute"):
        command.append("--execute")
    return command


class GuiServer(ThreadingHTTPServer):
    importer_defaults: argparse.Namespace
    run_token: str


class GuiRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path != "/":
            self.send_error(404)
            return
        server = cast(GuiServer, self.server)
        body = render_page(
            server.importer_defaults,
            server.run_token,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'unsafe-inline'; "
            "script-src 'unsafe-inline'; connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/run":
            self.send_error(404)
            return
        server = cast(GuiServer, self.server)
        request_token = self.headers.get("X-Karakeep-GUI-Token", "")
        if not secrets.compare_digest(request_token, server.run_token):
            self.send_error(403, "invalid GUI session token")
            return
        request_size = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(request_size))
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
        except (json.JSONDecodeError, ValueError) as error:
            self.send_error(400, str(error))
            return

        with tempfile.TemporaryDirectory() as directory:
            temporary_directory = Path(directory)
            effective_api_key = ""
            try:
                input_path = self._prepare_input(payload, temporary_directory)
                environment = os.environ.copy()
                api_key_env = str(payload["apiKeyEnv"])
                entered_api_key = str(payload.get("apiKey") or "")
                if entered_api_key:
                    environment[api_key_env] = entered_api_key
                effective_api_key = (
                    entered_api_key.strip() or environment.get(api_key_env, "").strip()
                )
                process = subprocess.Popen(
                    importer_command(payload, input_path),
                    cwd=Path.cwd(),
                    env=environment,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                )
            except (KeyError, OSError, TypeError, ValueError) as error:
                detail = self._redact(
                    f"Could not start importer: {error}",
                    effective_api_key,
                )
                self.send_error(400, detail)
                return

            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/x-ndjson; charset=utf-8",
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            output_stream = cast(TextIO, process.stdout)
            with output_stream:
                for line in output_stream:
                    self._send_event(
                        {
                            "type": "output",
                            "text": self._redact(line, effective_api_key),
                        }
                    )
            exit_code = process.wait()
            self._send_event({"type": "complete", "exitCode": exit_code})

    def _prepare_input(self, payload: Mapping[str, Any], directory: Path) -> Path:
        content = payload.get("inputContent")
        if isinstance(content, str):
            raw_name = str(payload.get("inputName") or "bookmarks-export")
            safe_name = raw_name.replace("\\", "/").rsplit("/", maxsplit=1)[-1]
            path = directory / (safe_name or "bookmarks-export")
            path.write_text(content, encoding="utf-8")
            return path
        return Path(str(payload["inputPath"])).expanduser()

    def _send_event(self, event: Mapping[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=False) + "\n"
        self.wfile.write(line.encode("utf-8"))
        self.wfile.flush()

    def _redact(self, value: str, api_key: str) -> str:
        return value.replace(api_key, "[REDACTED]") if api_key else value


def create_server(*, port: int) -> GuiServer:
    server = GuiServer(("127.0.0.1", port), GuiRequestHandler)
    server.importer_defaults = load_importer().build_parser().parse_args([])
    server.run_token = secrets.token_urlsafe(32)
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Open the Karakeep importer in a local browser."
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="print the local URL without opening a browser",
    )
    args = parser.parse_args(argv)

    server = create_server(port=0)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
