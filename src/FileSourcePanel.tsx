import { useState } from "react";

import Dropdown from "./Dropdown";
import { desktopApi as defaultDesktopApi } from "./desktop-api";
import type {
  FileSourceApi,
  FileSourceFormat,
  FileSourcePreview,
} from "./desktop-api";

export interface FileSourceSelection {
  path: string;
  preview: FileSourcePreview;
}

interface FileSourcePanelProps {
  api?: FileSourceApi;
  onContinue(selection: FileSourceSelection): void;
  onChooseAnotherSource(): void;
}

const formats: ReadonlyArray<{ value: FileSourceFormat; label: string }> = [
  { value: "auto", label: "Detect automatically" },
  { value: "fieldTheoryJsonl", label: "Field Theory JSONL" },
  { value: "chromeNetscape", label: "Chrome bookmarks" },
];

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || "Selected file";
}

function formatLabel(format: FileSourcePreview["format"]): string {
  return format === "fieldTheoryJsonl"
    ? "Field Theory JSONL"
    : "Chrome bookmarks";
}

function safeErrorMessage(error: unknown): string {
  const fallback =
    "The selected file could not be previewed. Choose its format and try again.";
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return fallback;
  }
  if (error.code === "fileUnreadable") {
    return "The selected file could not be read. Check its permissions and try again.";
  }
  if (!("position" in error)) {
    return fallback;
  }

  const { position } = error;
  if (
    typeof position !== "object" ||
    position === null ||
    !("kind" in position) ||
    (position.kind !== "line" && position.kind !== "bookmark") ||
    !("number" in position) ||
    typeof position.number !== "number" ||
    !Number.isSafeInteger(position.number) ||
    position.number < 1
  ) {
    return fallback;
  }

  const label = position.kind === "line" ? "Line" : "Bookmark";
  const location = `${label} ${position.number}`;
  switch (error.code) {
    case "invalidRecord":
      return `${location} must contain a valid bookmark record.`;
    case "duplicateSourceId":
      return `${location} has the same bookmark ID as an earlier record.`;
    case "invalidUrl":
      return `${location} must contain a valid HTTP or HTTPS bookmark URL.`;
    case "duplicateUrl":
      return `${location} has the same URL as an earlier bookmark.`;
    default:
      return fallback;
  }
}

export default function FileSourcePanel({
  api = defaultDesktopApi,
  onContinue,
  onChooseAnotherSource,
}: FileSourcePanelProps) {
  const [format, setFormat] = useState<FileSourceFormat>("auto");
  const [selection, setSelection] = useState<FileSourceSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function chooseAndPreview() {
    setBusy(true);
    setError(null);
    try {
      const path = await api.selectFileSource();
      if (path === null) {
        return;
      }
      const preview = await api.previewFileSource(path, format);
      setSelection({ path, preview });
    } catch (previewError) {
      setSelection(null);
      setError(safeErrorMessage(previewError));
    } finally {
      setBusy(false);
    }
  }

  const bookmarkCount = selection?.preview.bookmarks.length ?? 0;
  const countLabel = `${bookmarkCount} ${
    bookmarkCount === 1 ? "bookmark" : "bookmarks"
  }`;

  return (
    <section className="file-source-panel" aria-labelledby="file-source-title">
      <p className="eyebrow">Other sources</p>
      <h2 id="file-source-title">Preview a bookmark file</h2>
      <p>
        Choose a Field Theory JSONL or Chrome bookmarks file for this transfer.
        The file stays where it is and does not replace your active X Source.
      </p>

      <div className="file-source-controls">
        <Dropdown<FileSourceFormat>
          label="File format"
          value={format}
          options={formats}
          onChange={setFormat}
        />
        <button type="button" onClick={chooseAndPreview} disabled={busy}>
          {busy ? "Reading selected file…" : "Choose and preview file"}
        </button>
      </div>

      {error ? <p role="alert">{error}</p> : null}

      {selection ? (
        <div className="file-source-preview" aria-live="polite">
          <p>
            {fileName(selection.path)} · {formatLabel(selection.preview.format)}
          </p>
          <h3>
            {countLabel} ready
          </h3>
          <ul aria-label="Bookmarks in selected file" tabIndex={0}>
            {selection.preview.bookmarks.map((bookmark) => (
              <li key={bookmark.sourceId}>
                <strong>{bookmark.title}</strong>
                <span className="bookmark-url">{bookmark.url}</span>
                {bookmark.folders.length > 0 ? (
                  <ul aria-label={`Folders for ${bookmark.title}`}>
                    {bookmark.folders.map((folder) => (
                      <li key={folder}>{folder}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p aria-live="polite">No file selected.</p>
      )}
      <div className="source-choice-actions">
        {selection ? (
          <button
            type="button"
            onClick={() => onContinue(selection)}
            disabled={busy || bookmarkCount === 0}
          >
            Continue with {countLabel}
          </button>
        ) : null}
        <button
          type="button"
          className="button button--secondary"
          onClick={onChooseAnotherSource}
        >
          Choose another source
        </button>
      </div>
    </section>
  );
}
