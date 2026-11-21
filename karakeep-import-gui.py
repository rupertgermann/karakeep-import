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
FAVICON_PATH = Path(__file__).with_name("assets") / "favicon.png"


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
<html lang="en" data-theme="quiet-momentum">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="run-token" content="{escaped_run_token}">
  <title>Karakeep Importer</title>
  <link rel="icon" type="image/png" sizes="64x64" href="/favicon.png">
  <style>
    :root {{
      color-scheme: light;
      --color-bg: #F3EFE6;
      --color-surface: #FBF8F1;
      --color-surface-alt: #E7E3D8;
      --color-text: #263028;
      --color-muted: #687067;
      --color-primary: #526B54;
      --color-primary-hover: #3E5641;
      --color-signal: #E4B75D;
      --color-danger: #A9453D;
      --color-danger-hover: #8C352F;
      --color-focus: #B6583F;
      --color-border: #CEC9BC;
      --color-border-strong: #7B8178;
      --color-on-primary: #FBF8F1;
      --color-console: #202821;
      --color-console-text: #EEF0E7;
      --color-console-muted: #AAB2A8;
      --color-console-status: #E4B75D;
      --glow-primary: rgb(82 107 84 / 10%);
      --glow-signal: rgb(228 183 93 / 22%);
      --font-display: Fraunces, "Iowan Old Style", "Palatino Linotype",
        Georgia, serif;
      --font-body: "DM Sans", Avenir, "Segoe UI", sans-serif;
      --font-mono: "DM Mono", "SFMono-Regular", Consolas, monospace;
      --radius-sm: 10px;
      --radius-md: 18px;
      --shadow-sm: 0 1px 2px rgb(44 53 45 / 7%);
      --shadow-md: 0 16px 40px rgb(44 53 45 / 10%);
      --shadow-lg: 0 28px 70px rgb(44 53 45 / 14%);
      --duration-fast: 150ms;
      --duration-base: 280ms;
      --duration-slow: 700ms;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    }}
    *, *::before, *::after {{ box-sizing: border-box; }}
    html {{
      min-width: 320px;
      min-height: 100%;
      background: var(--color-bg);
    }}
    body {{
      min-width: 320px;
      min-height: 100vh;
      margin: 0;
      overflow-x: hidden;
      background:
        radial-gradient(
          circle at 94% 5%,
          var(--glow-signal) 0 8rem,
          transparent 8.1rem
        ),
        radial-gradient(
          circle at 4% 72%,
          var(--glow-primary) 0 12rem,
          transparent 12.1rem
        ),
        var(--color-bg);
      color: var(--color-text);
      font: 1rem/1.6 var(--font-body);
      -webkit-font-smoothing: antialiased;
    }}
    main {{
      width: min(100% - 2rem, 76rem);
      margin: 0 auto;
      padding: clamp(2rem, 6vw, 5.25rem) 0 5rem;
      animation: quiet-arrive var(--duration-slow) var(--ease-out) both;
    }}
    .hero {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(15rem, 23rem);
      align-items: end;
      gap: 2rem;
      margin-bottom: clamp(2rem, 5vw, 3.5rem);
    }}
    .eyebrow {{
      display: flex;
      align-items: center;
      gap: .65rem;
      margin: 0 0 .9rem;
      color: var(--color-primary);
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .16em;
      line-height: 1.3;
      text-transform: uppercase;
    }}
    .eyebrow::before {{
      width: 1.9rem;
      height: 2px;
      background: var(--color-signal);
      content: "";
    }}
    h1, h2, legend {{
      font-family: var(--font-display);
      text-wrap: balance;
    }}
    h1 {{
      max-width: 12ch;
      margin: 0;
      font-size: clamp(2.8rem, 7vw, 5.9rem);
      font-weight: 500;
      letter-spacing: -.055em;
      line-height: .91;
    }}
    h1 span {{ color: var(--color-primary); }}
    .intro {{
      max-width: 58ch;
      margin: 1.35rem 0 0;
      color: var(--color-muted);
      font-size: 1.05rem;
    }}
    .safety-note {{
      position: relative;
      padding: 1.25rem 1.35rem 1.25rem 1.5rem;
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      box-shadow: var(--shadow-sm);
    }}
    .safety-note::before {{
      position: absolute;
      inset: 0 auto 0 0;
      width: 5px;
      background: var(--color-signal);
      content: "";
    }}
    .safety-label {{
      display: block;
      margin-bottom: .35rem;
      color: var(--color-primary);
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
    }}
    .safety-note p {{
      margin: 0;
      color: var(--color-muted);
      font-size: .9rem;
      line-height: 1.5;
    }}
    .workspace {{
      display: grid;
      gap: 1.5rem;
    }}
    form {{ display: grid; gap: 1rem; }}
    fieldset, .run-panel {{
      min-width: 0;
      margin: 0;
      padding: clamp(1.15rem, 3vw, 1.75rem);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
      box-shadow: var(--shadow-sm);
      transition:
        border-color var(--duration-base) var(--ease-out),
        box-shadow var(--duration-base) var(--ease-out),
        transform var(--duration-base) var(--ease-out);
    }}
    fieldset:hover {{
      border-color: var(--color-border-strong);
      box-shadow: var(--shadow-md);
      transform: translateY(-2px);
    }}
    legend {{
      padding: 0 .55rem;
      color: var(--color-text);
      font-size: 1.5rem;
      font-weight: 500;
      letter-spacing: -.025em;
    }}
    .section-number {{
      display: inline-block;
      margin-right: .55rem;
      color: var(--color-primary);
      font: 700 .68rem/1 var(--font-mono);
      letter-spacing: .08em;
      vertical-align: .35em;
    }}
    .field-grid {{
      display: grid;
      grid-template-columns: minmax(11rem, .7fr) minmax(12rem, 1.3fr);
      align-items: center;
      gap: .85rem 1.25rem;
    }}
    label {{
      color: var(--color-muted);
      font-size: .8rem;
      font-weight: 700;
      letter-spacing: .025em;
    }}
    label:has(input[type="checkbox"]) {{
      display: flex;
      grid-column: 1 / -1;
      align-items: center;
      min-height: 2.75rem;
      padding: .65rem .8rem;
      border-radius: var(--radius-sm);
      background: var(--color-surface-alt);
      color: var(--color-text);
      font-size: .9rem;
      font-weight: 500;
      letter-spacing: 0;
      cursor: pointer;
    }}
    input, select, textarea, button {{
      min-width: 0;
      width: 100%;
      min-height: 2.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: .65rem .75rem;
      font: inherit;
    }}
    input, select, textarea {{
      background: var(--color-surface);
      color: var(--color-text);
      transition:
        border-color var(--duration-fast) var(--ease-out),
        box-shadow var(--duration-fast) var(--ease-out);
    }}
    input:hover, select:hover, textarea:hover {{
      border-color: var(--color-border-strong);
    }}
    input::placeholder, textarea::placeholder {{
      color: var(--color-muted);
      opacity: .8;
    }}
    input::file-selector-button {{
      margin: -.35rem .75rem -.35rem -.35rem;
      border: 0;
      border-radius: 7px;
      padding: .45rem .65rem;
      background: var(--color-surface-alt);
      color: var(--color-primary);
      font: 700 .78rem/1.2 var(--font-body);
      cursor: pointer;
    }}
    input[type="checkbox"] {{
      width: 1.1rem;
      min-height: auto;
      margin: 0 .45rem 0 0;
      accent-color: var(--color-primary);
    }}
    textarea {{ min-height: 5rem; resize: vertical; }}
    .actions {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }}
    button {{
      min-height: 3.25rem;
      border-color: transparent;
      background: var(--color-primary);
      color: var(--color-on-primary);
      font-weight: 700;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      transition:
        background var(--duration-fast) var(--ease-out),
        border-color var(--duration-fast) var(--ease-out),
        color var(--duration-fast) var(--ease-out),
        transform var(--duration-fast) var(--ease-out);
    }}
    button:hover {{
      background: var(--color-primary-hover);
      transform: translateY(-1px);
    }}
    #execute-button {{
      border-color: var(--color-danger);
      background: transparent;
      color: var(--color-danger);
      box-shadow: none;
    }}
    #execute-button:hover {{
      background: var(--color-danger);
      color: var(--color-surface);
    }}
    button:disabled {{
      cursor: wait;
      opacity: .52;
      transform: none;
    }}
    input:focus-visible, select:focus-visible, textarea:focus-visible,
    button:focus-visible {{
      outline: 3px solid var(--color-focus);
      outline-offset: 3px;
    }}
    dialog {{
      width: min(calc(100% - 2rem), 30rem);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: 0;
      background: var(--color-surface);
      color: var(--color-text);
      box-shadow: var(--shadow-lg);
    }}
    dialog[open] {{
      animation: quiet-dialog-arrive var(--duration-base) var(--ease-out) both;
    }}
    dialog::backdrop {{
      background: rgb(23 29 24 / 76%);
      backdrop-filter: blur(4px);
    }}
    .dialog-content {{
      position: relative;
      margin: 0;
      padding: 2rem;
      text-align: center;
    }}
    .dialog-warning {{
      display: grid;
      width: 3.25rem;
      height: 3.25rem;
      margin: 0 auto 1.25rem;
      place-items: center;
      border: 1px solid var(--color-danger);
      border-radius: 50%;
      background: var(--color-surface-alt);
      color: var(--color-danger);
      font: 600 1.45rem/1 var(--font-display);
    }}
    .dialog-kicker {{
      margin: 0 0 .45rem !important;
      color: var(--color-danger) !important;
      font: 700 .68rem/1.3 var(--font-mono);
      letter-spacing: .14em;
      text-transform: uppercase;
    }}
    .dialog-content h2 {{
      margin: 0 0 .75rem;
      font-size: 2rem;
      font-weight: 500;
      letter-spacing: -.035em;
      line-height: 1;
    }}
    .dialog-content p {{
      margin: 0 auto 1.5rem;
      max-width: 34ch;
      color: var(--color-muted);
    }}
    .dialog-actions {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: .75rem;
    }}
    #cancel-execute-button {{
      background: var(--color-surface-alt);
      color: var(--color-text);
    }}
    #cancel-execute-button:hover {{ background: var(--color-border); }}
    #confirm-execute-button {{ background: var(--color-danger); }}
    #confirm-execute-button:hover {{
      background: var(--color-danger-hover);
    }}
    .run-panel {{
      align-self: start;
      border-color: transparent;
      background: var(--color-console);
      color: var(--color-console-text);
      box-shadow: var(--shadow-md);
    }}
    .run-panel h2 {{
      margin: 0;
      color: var(--color-console-text);
      font-size: 1.65rem;
      font-weight: 500;
      letter-spacing: -.025em;
    }}
    .run-kicker {{
      margin: 0 0 .25rem;
      color: var(--color-signal);
      font: 700 .68rem/1.3 var(--font-mono);
      letter-spacing: .14em;
      text-transform: uppercase;
    }}
    #run-status {{
      display: inline-flex;
      align-items: center;
      gap: .55rem;
      margin: 1rem 0 1.25rem;
      color: var(--color-console-status);
      font-size: .84rem;
      font-weight: 700;
    }}
    #run-status::before {{
      width: .5rem;
      height: .5rem;
      border-radius: 50%;
      background: currentColor;
      content: "";
      box-shadow: 0 0 0 4px rgb(228 183 93 / 12%);
    }}
    #output {{
      min-height: 10rem;
      max-height: 28rem;
      margin: 0;
      padding-top: 1rem;
      overflow: auto;
      border-top: 1px solid rgb(238 240 231 / 16%);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--color-console-muted);
      font: .82rem/1.65 var(--font-mono);
    }}
    @media (min-width: 64rem) {{
      .workspace {{
        grid-template-columns: minmax(0, 1.45fr) minmax(19rem, .8fr);
        align-items: start;
      }}
      .run-panel {{
        position: sticky;
        top: 1.5rem;
      }}
    }}
    @media (max-width: 42rem) {{
      main {{ width: min(100% - 1rem, 76rem); padding-top: 1.5rem; }}
      .hero {{ grid-template-columns: 1fr; gap: 1.25rem; }}
      h1 {{ font-size: clamp(2.65rem, 15vw, 4.2rem); }}
      .safety-note {{ padding: 1rem 1rem 1rem 1.25rem; }}
      fieldset, .run-panel {{ padding: 1rem; }}
      .field-grid {{ grid-template-columns: 1fr; }}
      .actions {{ grid-template-columns: 1fr; }}
      label:has(input[type="checkbox"]) {{ grid-column: auto; }}
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        color-scheme: dark;
        --color-bg: #171D18;
        --color-surface: #202821;
        --color-surface-alt: #2A332B;
        --color-text: #EEF0E7;
        --color-muted: #AAB2A8;
        --color-primary: #A9C2A5;
        --color-primary-hover: #C0D4BC;
        --color-signal: #D6AE66;
        --color-danger: #E18B7F;
        --color-danger-hover: #F0A197;
        --color-focus: #E18B7F;
        --color-border: #424C43;
        --color-border-strong: #778178;
        --color-on-primary: #172019;
        --color-console: #111512;
        --color-console-text: #EEF0E7;
        --color-console-muted: #AAB2A8;
        --color-console-status: #D6AE66;
        --glow-primary: rgb(169 194 165 / 10%);
        --glow-signal: rgb(214 174 102 / 12%);
        --shadow-sm: 0 1px 2px rgb(0 0 0 / 22%);
        --shadow-md: 0 16px 40px rgb(0 0 0 / 28%);
        --shadow-lg: 0 28px 70px rgb(0 0 0 / 40%);
      }}
    }}
    @keyframes quiet-arrive {{
      from {{ opacity: 0; transform: translateY(18px); }}
      to {{ opacity: 1; transform: translateY(0); }}
    }}
    @keyframes quiet-dialog-arrive {{
      from {{ opacity: 0; transform: translateY(12px) scale(.98); }}
      to {{ opacity: 1; transform: translateY(0) scale(1); }}
    }}
    @media (prefers-reduced-motion: reduce) {{
      *, *::before, *::after {{
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: .01ms !important;
      }}
    }}
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <div>
        <p class="eyebrow">Preview-first bookmark transfer</p>
        <h1>Karakeep <span>Importer</span></h1>
        <p class="intro">
          Bring Field Theory and Chrome bookmarks into Karakeep with a
          careful, resumable workflow.
        </p>
      </div>
      <aside class="safety-note" aria-label="Preview safety">
        <span class="safety-label">Safe by default</span>
        <p>Preview is always safe: no data is sent to Karakeep.</p>
      </aside>
    </header>
    <div class="workspace">
      <form id="import-form">
      <fieldset>
        <legend>
          <span class="section-number" aria-hidden="true">01</span>
          Bookmark export
        </legend>
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
        <legend>
          <span class="section-number" aria-hidden="true">02</span>
          Karakeep
        </legend>
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
        <legend>
          <span class="section-number" aria-hidden="true">03</span>
          Bookmark metadata
        </legend>
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
        <legend>
          <span class="section-number" aria-hidden="true">04</span>
          Execution
        </legend>
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
        <div class="dialog-warning" aria-hidden="true">!</div>
        <p class="dialog-kicker">Live import</p>
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
        <p class="run-kicker">Local CLI stream</p>
        <h2 id="output-heading">Run output</h2>
        <p id="run-status" role="status" aria-live="polite">
          Ready to preview.
        </p>
        <pre id="output" role="log" aria-live="polite" tabindex="0"></pre>
      </section>
    </div>
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
        if self.path == "/favicon.png":
            body = FAVICON_PATH.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
            return
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

            with process:
                try:
                    self.send_response(200)
                    self.send_header(
                        "Content-Type",
                        "application/x-ndjson; charset=utf-8",
                    )
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()

                    for line in cast(TextIO, process.stdout):
                        self._send_event(
                            {
                                "type": "output",
                                "text": self._redact(line, effective_api_key),
                            }
                        )
                    exit_code = process.wait()
                    self._send_event({"type": "complete", "exitCode": exit_code})
                except ConnectionError:
                    process.terminate()

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
