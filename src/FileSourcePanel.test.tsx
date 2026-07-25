import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import FileSourcePanel from "./FileSourcePanel";
import type {
  FileSourceApi,
  FileSourcePreview,
} from "./desktop-api";

const preview: FileSourcePreview = {
  format: "fieldTheoryJsonl",
  bookmarks: [
    {
      sourceId: "123",
      url: "https://x.com/example/status/123",
      title: "First saved post",
      note: "Private preview note",
      createdAt: "2023-10-11T14:08:46Z",
      tags: ["twitter", "Reading"],
      folders: ["Reading"],
    },
    {
      sourceId: "456",
      url: "https://x.com/example/status/456",
      title: "Second saved post",
      note: "",
      createdAt: null,
      tags: ["twitter"],
      folders: [],
    },
  ],
};

describe("Other sources File Source", () => {
  it("selects and previews a multi-record file through the desktop boundary", async () => {
    const api: FileSourceApi = {
      selectFileSource: vi.fn().mockResolvedValue(
        "/private/selected/bookmarks.jsonl",
      ),
      previewFileSource: vi.fn().mockResolvedValue(preview),
    };

    render(<FileSourcePanel api={api} onContinue={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );

    expect(
      await screen.findByRole("heading", { name: "2 bookmarks ready" }),
    ).toBeInTheDocument();
    expect(screen.getByText("First saved post")).toBeInTheDocument();
    expect(screen.getByText("Second saved post")).toBeInTheDocument();
    expect(screen.getByText("Reading")).toBeInTheDocument();
    expect(api.previewFileSource).toHaveBeenCalledWith(
      "/private/selected/bookmarks.jsonl",
      "auto",
    );
  });

  it("offers an explicit Field Theory fallback without exposing unsafe error details", async () => {
    const api: FileSourceApi = {
      selectFileSource: vi
        .fn()
        .mockResolvedValue("/private/selected/bookmarks.txt"),
      previewFileSource: vi
        .fn()
        .mockRejectedValueOnce({
          code: "invalidFileSource",
          message:
            "raw parser detail containing /private/selected and bookmark text",
        })
        .mockResolvedValueOnce({ ...preview, bookmarks: [preview.bookmarks[0]] }),
    };

    render(<FileSourcePanel api={api} onContinue={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The selected file could not be previewed. Choose its format and try again.",
    );
    expect(screen.queryByText(/secret-name/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "File format" }), {
      target: { value: "fieldTheoryJsonl" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );

    expect(
      await screen.findByRole("heading", { name: "1 bookmark ready" }),
    ).toBeInTheDocument();
    expect(api.previewFileSource).toHaveBeenLastCalledWith(
      "/private/selected/bookmarks.txt",
      "fieldTheoryJsonl",
    );
  });

  it("does not change state when the native file picker is cancelled", async () => {
    const api: FileSourceApi = {
      selectFileSource: vi.fn().mockResolvedValue(null),
      previewFileSource: vi.fn(),
    };

    render(<FileSourcePanel api={api} onContinue={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );

    expect(await screen.findByText("No file selected.")).toBeInTheDocument();
    expect(api.previewFileSource).not.toHaveBeenCalled();
  });

  it("hands the confirmed one-run File Source to the transfer seam", async () => {
    const selectedPath = "C:\\Transfer\\bookmarks.jsonl";
    const oneBookmarkPreview = {
      ...preview,
      bookmarks: [preview.bookmarks[0]],
    };
    const onContinue = vi.fn();
    const api: FileSourceApi = {
      selectFileSource: vi.fn().mockResolvedValue(selectedPath),
      previewFileSource: vi.fn().mockResolvedValue(oneBookmarkPreview),
    };

    render(<FileSourcePanel api={api} onContinue={onContinue} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue with 1 bookmark",
      }),
    );

    expect(onContinue).toHaveBeenCalledWith({
      path: selectedPath,
      preview: oneBookmarkPreview,
    });
  });
});
