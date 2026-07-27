import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import TransferReview from "./TransferReview";
import {
  defaultTransferOptions,
  type TransferPreview,
  type TransferProgress,
  type TransferResult,
} from "./workflow";

const preview: TransferPreview = {
  total: 18,
  pending: 12,
  previouslyDelivered: 6,
  folders: ["Reading", "Reference"],
  destination: {
    serverUrl: "https://keep.example.com",
    userId: "user-1",
    userName: "Taylor",
  },
};

const progress: TransferProgress = {
  completed: 6,
  total: 12,
};

const result: TransferResult = {
  delivered: 9,
  created: 7,
  existing: 2,
  retried: 1,
  failed: 1,
  cancelled: 1,
};

describe("TransferReview", () => {
  it("shows the selected Destination", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Destination")).toHaveTextContent(
      "Taylorhttps://keep.example.com",
    );
  });

  it("shows total, pending, and previously delivered counts", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Transfer summary")).toHaveTextContent(
      "Total18Pending12Previously delivered6",
    );
  });

  it("shows source folders in the preview", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Folders")).toHaveTextContent(
      "ReadingReference",
    );
  });

  it("explains when the snapshot has no folders", () => {
    render(
      <TransferReview
        phase="preview"
        preview={{ ...preview, folders: [] }}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(screen.getByText("No folders in this snapshot.")).toBeInTheDocument();
  });

  it("can choose another source from the preview", () => {
    const onChooseAnotherSource = vi.fn();
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={onChooseAnotherSource}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose another source" }),
    );

    expect(onChooseAnotherSource).toHaveBeenCalledOnce();
  });

  it("does not start delivery from the initial action", () => {
    const onStart = vi.fn();
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={onStart}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));

    expect(onStart).not.toHaveBeenCalled();
  });

  it("explains the delivery consequence before confirmation", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));

    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "12 pending bookmarks will be delivered to Taylor",
    );
  });

  it("moves focus into the explicit confirmation", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));

    expect(screen.getByRole("button", { name: "Not yet" })).toHaveFocus();
  });

  it("returns focus to the start action when confirmation is cancelled", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));

    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));

    expect(screen.getByRole("button", { name: "Start transfer" })).toHaveFocus();
  });

  it("dismisses the confirmation with Escape", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps the confirmation open for other keyboard input", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Tab" });

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("starts only after explicit confirmation", () => {
    const onStart = vi.fn();
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        onOptionsChange={vi.fn()}
        onStart={onStart}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm transfer" }),
    );

    expect(onStart).toHaveBeenCalledOnce();
  });

  it("shows live processed and total progress", () => {
    render(
      <TransferReview
        phase="progress"
        progress={progress}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("progressbar", {
        name: "6 of 12 bookmarks processed",
      }),
    ).toHaveAttribute("value", "6");
  });

  it("reports progress while the total is still being calculated", () => {
    render(
      <TransferReview
        phase="progress"
        progress={{ completed: 4, total: null }}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "4 bookmarks processed",
    );
  });

  it("allows the active delivery to be cancelled", () => {
    const onCancel = vi.fn();
    render(
      <TransferReview
        phase="progress"
        progress={progress}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows every terminal delivery outcome", () => {
    render(
      <TransferReview
        phase="result"
        result={result}
        onRetryPending={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Transfer results")).toHaveTextContent(
      "Delivered9Created7Existing2Retried1Failed1Cancelled1",
    );
  });

  it("allows pending bookmarks to be retried", () => {
    const onRetryPending = vi.fn();
    render(
      <TransferReview
        phase="result"
        result={result}
        onRetryPending={onRetryPending}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry 2 pending" }));

    expect(onRetryPending).toHaveBeenCalledOnce();
  });

  it("does not offer a pending retry after a complete result", () => {
    render(
      <TransferReview
        phase="result"
        result={{ ...result, failed: 0, cancelled: 0 }}
        onRetryPending={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });

  it("allows a user to choose another source", () => {
    const onChooseAnotherSource = vi.fn();
    render(
      <TransferReview
        phase="result"
        result={result}
        onRetryPending={vi.fn()}
        onChooseAnotherSource={onChooseAnotherSource}
      />,
    );

    fireEvent.click(
      within(screen.getByLabelText("Result actions")).getByRole("button", {
        name: "Choose another source",
      }),
    );

    expect(onChooseAnotherSource).toHaveBeenCalledOnce();
  });
});

describe("TransferReview transfer options", () => {
  function renderOptions(
    options = defaultTransferOptions,
    onOptionsChange = vi.fn(),
  ) {
    render(
      <TransferReview
        phase="preview"
        preview={{ ...preview, preservedTimestamps: 9 }}
        options={options}
        onOptionsChange={onOptionsChange}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );
    return onOptionsChange;
  }

  it("reports how many pending records keep their source timestamp", () => {
    renderOptions();

    expect(screen.getByLabelText("Transfer summary")).toHaveTextContent(
      "Timestamps preserved9",
    );
  });

  it.each([
    ["Attach source tags", "includeDefaultTags"],
    ["Attach tags from the export", "includeExportTags"],
    ["Include source titles", "includeTitles"],
    ["Include source notes", "includeNotes"],
  ])("suppresses %s independently", (label, key) => {
    const onOptionsChange = renderOptions();

    fireEvent.click(screen.getByRole("checkbox", { name: label }));

    expect(onOptionsChange).toHaveBeenCalledWith({
      ...defaultTransferOptions,
      [key]: false,
    });
  });

  it("collects extra tags once the field is left", () => {
    const onOptionsChange = renderOptions();
    const field = screen.getByLabelText("Extra tags");

    fireEvent.change(field, { target: { value: " Imported , , archive " } });
    expect(onOptionsChange).not.toHaveBeenCalled();
    fireEvent.blur(field);

    expect(onOptionsChange).toHaveBeenCalledWith({
      ...defaultTransferOptions,
      extraTags: ["Imported", "archive"],
    });
  });

  it("chooses the source field that becomes the creation date", () => {
    const onOptionsChange = renderOptions();

    fireEvent.change(screen.getByLabelText("Creation date"), {
      target: { value: "bookmarkedAt" },
    });

    expect(onOptionsChange).toHaveBeenCalledWith({
      ...defaultTransferOptions,
      timestampField: "bookmarkedAt",
    });
  });

  it("caps the run at a positive limit and treats anything else as uncapped", () => {
    const onOptionsChange = renderOptions();
    const field = screen.getByLabelText("Limit this run to");

    fireEvent.change(field, { target: { value: "10" } });
    fireEvent.change(field, { target: { value: "0" } });

    expect(onOptionsChange.mock.calls.map(([options]) => options.limit)).toEqual(
      [10, null],
    );
  });

  it("locks the options while a changed preview is being prepared", () => {
    render(
      <TransferReview
        phase="preview"
        preview={preview}
        options={defaultTransferOptions}
        optionsBusy
        onOptionsChange={vi.fn()}
        onStart={vi.fn()}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Extra tags")).toBeDisabled();
  });
});
