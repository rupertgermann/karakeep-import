import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Settings from "./Settings";
import {
  DELETE_LOCAL_TRANSFER_DATA,
  FORGET_KARAKEEP_CONNECTION,
  REPLACE_X_SOURCE,
  type DiagnosticsExport,
  type SettingsApi,
} from "./settings-api";

const diagnostics: DiagnosticsExport = {
  generatedByUserAction: true,
  includesBookmarkContent: false,
  telemetryEnabled: false,
  versions: {
    app: "0.1.0",
    fieldTheory: "1.3.22",
    node: "22.17.0",
    schema: "1",
    karakeepBaseline: "0.32.0",
  },
  source: "ready",
  destination: "ready",
  storage: {
    dataDirectory: "[redacted]",
    snapshotBytes: 1_024,
    ledgerBytes: 2_048,
  },
  lastFailure: null,
};

function createSettingsApi(): SettingsApi {
  return {
    inspectPrivateData: vi.fn().mockResolvedValue({
      dataDirectory: "/Application Support/Karakeep Transfer",
      snapshotBytes: 1_024,
      acquisitionStateBytes: 512,
      ledgerBytes: 2_048,
      totalBytes: 3_584,
    }),
    replaceXSource: vi.fn().mockResolvedValue(undefined),
    deleteLocalTransferData: vi.fn().mockResolvedValue(undefined),
    exportDiagnostics: vi.fn().mockResolvedValue(diagnostics),
    saveDiagnostics: vi.fn().mockResolvedValue(false),
    versionInformation: vi.fn().mockResolvedValue(diagnostics.versions),
    manualUpdateCheck: vi.fn().mockResolvedValue({
      requestedByUser: true,
      releasePage:
        "https://github.com/rupertgermann/karakeep-import/releases/latest",
      downloadsUpdate: false,
      executesUpdate: false,
    }),
  };
}

describe("Settings", () => {
  it("discloses the local data location without bookmark content", async () => {
    render(<Settings api={createSettingsApi()} />);

    expect(
      await screen.findByText("/Application Support/Karakeep Transfer"),
    ).toBeInTheDocument();
  });

  it("shows the total private data size", async () => {
    render(<Settings api={createSettingsApi()} />);

    expect(await screen.findByText("3.5 KB")).toBeInTheDocument();
  });

  it("reports when Settings information cannot be read", async () => {
    const api = createSettingsApi();
    vi.mocked(api.inspectPrivateData).mockRejectedValue(
      new Error("storage unavailable"),
    );

    render(<Settings api={api} />);

    expect(
      await screen.findByText("Settings information is unavailable."),
    ).toBeInTheDocument();
  });

  it("explains the X Source replacement boundary before acting", async () => {
    render(<Settings api={createSettingsApi()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Replace X Source" }),
    );

    expect(
      screen.getByText(
        "This removes the local Bookmark Snapshot and acquisition state. Destination delivery history remains.",
      ),
    ).toBeInTheDocument();
  });

  it("moves keyboard focus into destructive confirmations", () => {
    render(<Settings api={createSettingsApi()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete local transfer data" }),
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("cancels source replacement without changing private data", () => {
    render(<Settings api={createSettingsApi()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Replace X Source" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("uses the X Source replacement confirmation capability", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Replace X Source" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm source replacement" }),
    );

    await waitFor(() =>
      expect(api.replaceXSource).toHaveBeenCalledWith(REPLACE_X_SOURCE),
    );
  });

  it("explains that local deletion does not affect Karakeep", () => {
    render(<Settings api={createSettingsApi()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete local transfer data" }),
    );

    expect(
      screen.getByText(
        "This deletes the local Bookmark Snapshot and Delivery Ledger. Bookmarks already in Karakeep are not deleted.",
      ),
    ).toBeInTheDocument();
  });

  it("uses the local deletion confirmation capability", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete local transfer data" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm local data deletion" }),
    );

    await waitFor(() =>
      expect(api.deleteLocalTransferData).toHaveBeenCalledWith(
        DELETE_LOCAL_TRANSFER_DATA,
      ),
    );
  });

  it("notifies the shell after local transfer data is deleted", async () => {
    const api = createSettingsApi();
    const onLocalDataDeleted = vi.fn();
    render(
      <Settings
        api={api}
        onLocalDataDeleted={onLocalDataDeleted}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete local transfer data" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm local data deletion" }),
    );

    await waitFor(() => expect(onLocalDataDeleted).toHaveBeenCalledOnce());
  });

  it("does not notify the shell when local data deletion is rejected", async () => {
    const api = createSettingsApi();
    const onLocalDataDeleted = vi.fn();
    vi.mocked(api.deleteLocalTransferData).mockRejectedValue(
      new Error("private deletion failure"),
    );
    render(
      <Settings
        api={api}
        onLocalDataDeleted={onLocalDataDeleted}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete local transfer data" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm local data deletion" }),
    );

    expect(
      await screen.findByText("The Settings action could not be completed."),
    ).toBeInTheDocument();
    expect(onLocalDataDeleted).not.toHaveBeenCalled();
  });

  it("exposes a typed callback seam for forgetting the connection", async () => {
    const onForgetKarakeepConnection = vi.fn().mockResolvedValue(undefined);
    render(
      <Settings
        api={createSettingsApi()}
        onForgetKarakeepConnection={onForgetKarakeepConnection}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Forget Karakeep connection" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm forgetting connection" }),
    );

    await waitFor(() =>
      expect(onForgetKarakeepConnection).toHaveBeenCalledWith(
        FORGET_KARAKEEP_CONNECTION,
      ),
    );
  });

  it("opens the native save flow for redacted diagnostics", async () => {
    const api = createSettingsApi();
    vi.mocked(api.saveDiagnostics).mockResolvedValue(true);
    render(<Settings api={api} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Export diagnostics" }),
    );

    await waitFor(() => expect(api.saveDiagnostics).toHaveBeenCalledOnce());
    expect(api.exportDiagnostics).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Redacted diagnostics were saved."),
    ).toBeInTheDocument();
  });

  it("reports when the native diagnostics save dialog is cancelled", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Export diagnostics" }),
    );

    expect(
      await screen.findByText("Diagnostics export was cancelled."),
    ).toBeInTheDocument();
  });

  it("reports a rejected Settings action without leaking its error", async () => {
    const api = createSettingsApi();
    const onXSourceReplaced = vi.fn();
    vi.mocked(api.replaceXSource).mockRejectedValue(
      new Error("secret-bearing OS error"),
    );
    render(
      <Settings api={api} onXSourceReplaced={onXSourceReplaced} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Replace X Source" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm source replacement" }),
    );

    expect(
      await screen.findByText("The Settings action could not be completed."),
    ).toBeInTheDocument();
    expect(onXSourceReplaced).not.toHaveBeenCalled();
  });

  it("does not check for updates automatically", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);

    await screen.findByText((content) =>
      content.startsWith("Karakeep Transfer 0.1.0"),
    );

    expect(api.manualUpdateCheck).not.toHaveBeenCalled();
  });

  it("shows the signed release link after a manual update check", async () => {
    render(<Settings api={createSettingsApi()} />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(
      await screen.findByRole("link", { name: "Open signed releases" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/rupertgermann/karakeep-import/releases/latest",
    );
  });
});
