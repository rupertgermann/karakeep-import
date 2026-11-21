import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import FileSourcePanel from "./FileSourcePanel";
import type {
  FileSourceApi,
  FileSourceCommandError,
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

    render(
      <FileSourcePanel
        api={api}
        onContinue={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
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

  it("prevents continuing with the previous file while a replacement is being read", async () => {
    const replacementPath = "/private/selected/replacement.jsonl";
    let finishPreview = () => {};
    const pendingPreview = new Promise<FileSourcePreview>((resolve) => {
      finishPreview = () => resolve(preview);
    });
    const onContinue = vi.fn();
    const api: FileSourceApi = {
      selectFileSource: vi
        .fn()
        .mockResolvedValueOnce("/private/selected/bookmarks.jsonl")
        .mockResolvedValueOnce(replacementPath),
      previewFileSource: vi
        .fn()
        .mockResolvedValueOnce(preview)
        .mockReturnValueOnce(pendingPreview),
    };

    render(
      <FileSourcePanel
        api={api}
        onContinue={onContinue}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    const chooseFile = screen.getByRole("button", {
      name: "Choose and preview file",
    });
    fireEvent.click(chooseFile);
    const continueButton = await screen.findByRole("button", {
      name: "Continue with 2 bookmarks",
    });
    fireEvent.click(chooseFile);
    await waitFor(() =>
      expect(api.previewFileSource).toHaveBeenLastCalledWith(
        replacementPath,
        "auto",
      ),
    );

    expect(continueButton).toBeDisabled();
    finishPreview();
    await screen.findByText(/replacement\.jsonl/);
    fireEvent.click(continueButton);
    expect(onContinue).toHaveBeenCalledWith({ path: replacementPath, preview });
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

    render(
      <FileSourcePanel
        api={api}
        onContinue={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The selected file could not be previewed. Choose its format and try again.",
    );
    expect(screen.queryByText(/raw parser detail/)).not.toBeInTheDocument();
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

  it.each([
    {
      code: "duplicateUrl",
      position: { kind: "bookmark", number: 2 },
      message: "Bookmark 2 has the same URL as an earlier bookmark.",
    },
    {
      code: "invalidUrl",
      position: { kind: "line", number: 3 },
      message: "Line 3 must contain a valid HTTP or HTTPS bookmark URL.",
    },
  ] satisfies FileSourceCommandError[])(
    "describes the $code validation problem and safe record position",
    async ({ code, position, message }) => {
      render(
        <FileSourcePanel
          api={{
            selectFileSource: vi
              .fn()
              .mockResolvedValue("/private/selected/bookmarks.txt"),
            previewFileSource: vi.fn().mockRejectedValue({
              code,
              position,
              message: "private bookmark contents",
            }),
          }}
          onContinue={vi.fn()}
          onChooseAnotherSource={vi.fn()}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Choose and preview file" }),
      );

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent("private bookmark contents");
    },
  );

  it("does not change state when the native file picker is cancelled", async () => {
    const api: FileSourceApi = {
      selectFileSource: vi.fn().mockResolvedValue(null),
      previewFileSource: vi.fn(),
    };

    render(
      <FileSourcePanel
        api={api}
        onContinue={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
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

    render(
      <FileSourcePanel
        api={api}
        onContinue={onContinue}
        onChooseAnotherSource={vi.fn()}
      />,
    );
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

  it("lets the user leave File Source setup before selecting a file", () => {
    const onChooseAnotherSource = vi.fn();
    const api: FileSourceApi = {
      selectFileSource: vi.fn(),
      previewFileSource: vi.fn(),
    };

    render(
      <FileSourcePanel
        api={api}
        onContinue={vi.fn()}
        onChooseAnotherSource={onChooseAnotherSource}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another source" }),
    );

    expect(onChooseAnotherSource).toHaveBeenCalledOnce();
  });
});
