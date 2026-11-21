import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Settings from "./Settings";
import {
  DEFAULT_TRANSFER_PREFERENCES,
  DELETE_LOCAL_TRANSFER_DATA,
  FORGET_KARAKEEP_CONNECTION,
  REPLACE_X_SOURCE,
  type ComponentVersions,
  type SettingsApi,
} from "./settings-api";

const versions: ComponentVersions = {
  app: "0.1.0",
  fieldTheory: "1.3.22",
  node: "22.17.0",
  schema: "1",
  karakeepBaseline: "0.32.0",
};

function createSettingsApi(): SettingsApi {
  return {
    transferPreferences: vi
      .fn()
      .mockResolvedValue(DEFAULT_TRANSFER_PREFERENCES),
    saveTransferPreferences: vi
      .fn()
      .mockImplementation((settings) => Promise.resolve(settings)),
    inspectPrivateData: vi.fn().mockResolvedValue({
      dataDirectory: "/Application Support/Karakeep Transfer",
      snapshotBytes: 1_024,
      acquisitionStateBytes: 512,
      ledgerBytes: 2_048,
      totalBytes: 3_584,
    }),
    replaceXSource: vi.fn().mockResolvedValue(undefined),
    deleteLocalTransferData: vi.fn().mockResolvedValue(undefined),
    saveDiagnostics: vi.fn().mockResolvedValue(false),
    versionInformation: vi.fn().mockResolvedValue(versions),
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
  it("puts transfer preferences first and groups related settings together", async () => {
    render(<Settings api={createSettingsApi()} />);

    expect(
      (await screen.findAllByRole("heading", { level: 3 })).map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      "Source tags",
      "Advanced delivery tuning",
      "Karakeep connection",
      "Private transfer data",
      "Diagnostics",
      "Version and updates",
    ]);
  });

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

  it("notifies the shell when deletion succeeds but refreshing data fails", async () => {
    const api = createSettingsApi();
    vi.mocked(api.inspectPrivateData)
      .mockResolvedValueOnce({
        dataDirectory: "/Application Support/Karakeep Transfer",
        snapshotBytes: 1_024,
        acquisitionStateBytes: 512,
        ledgerBytes: 2_048,
        totalBytes: 3_584,
      })
      .mockRejectedValueOnce(new Error("refresh failed"));
    const onLocalDataDeleted = vi.fn();
    render(
      <Settings
        api={api}
        onLocalDataDeleted={onLocalDataDeleted}
      />,
    );
    await screen.findByText("/Application Support/Karakeep Transfer");
    fireEvent.click(
      screen.getByRole("button", { name: "Delete local transfer data" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm local data deletion" }),
    );

    await waitFor(() => expect(onLocalDataDeleted).toHaveBeenCalledOnce());
  });

  it("notifies the shell when source replacement succeeds but refreshing data fails", async () => {
    const api = createSettingsApi();
    vi.mocked(api.inspectPrivateData)
      .mockResolvedValueOnce({
        dataDirectory: "/Application Support/Karakeep Transfer",
        snapshotBytes: 1_024,
        acquisitionStateBytes: 512,
        ledgerBytes: 2_048,
        totalBytes: 3_584,
      })
      .mockRejectedValueOnce(new Error("refresh failed"));
    const onXSourceReplaced = vi.fn();
    render(
      <Settings
        api={api}
        onXSourceReplaced={onXSourceReplaced}
      />,
    );
    await screen.findByText("/Application Support/Karakeep Transfer");
    fireEvent.click(
      screen.getByRole("button", { name: "Replace X Source" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm source replacement" }),
    );

    await waitFor(() => expect(onXSourceReplaced).toHaveBeenCalledOnce());
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

  it("shows the tested Karakeep baseline in version information", async () => {
    render(<Settings api={createSettingsApi()} />);

    expect(
      await screen.findByText((content) =>
        content.includes("Karakeep baseline 0.32.0"),
      ),
    ).toBeInTheDocument();
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

describe("Settings source tags and delivery tuning", () => {
  it("shows no selected source tag until one is chosen", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);

    const twitter = await screen.findByRole("checkbox", {
      name: "twitter, for X bookmarks",
    });

    expect(twitter).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: "fieldtheory, the internal acquisition name",
      }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "chrome, for Chrome bookmark files" }),
    ).not.toBeChecked();
  });

  it("saves a chosen source tag", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "fieldtheory, the internal acquisition name",
      }),
    );

    await waitFor(() =>
      expect(api.saveTransferPreferences).toHaveBeenCalledWith({
        ...DEFAULT_TRANSFER_PREFERENCES,
        defaultTags: {
          ...DEFAULT_TRANSFER_PREFERENCES.defaultTags,
          fieldTheory: true,
        },
      }),
    );
  });

  it("shows the shipped delivery tuning and saves a change", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);

    expect(await screen.findByLabelText("Workers")).toHaveValue(4);
    expect(screen.getByLabelText("Requests per second")).toHaveValue(4);
    expect(screen.getByLabelText("Request timeout in seconds")).toHaveValue(20);
    expect(screen.getByLabelText("Maximum retries")).toHaveValue(5);

    fireEvent.change(screen.getByLabelText("Workers"), {
      target: { value: "2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save delivery tuning" }),
    );

    await waitFor(() =>
      expect(api.saveTransferPreferences).toHaveBeenCalledWith({
        ...DEFAULT_TRANSFER_PREFERENCES,
        deliveryTuning: {
          ...DEFAULT_TRANSFER_PREFERENCES.deliveryTuning,
          workers: 2,
        },
      }),
    );
  });

  it.each([0, 33])("rejects a worker count of %i without storing it", async (count) => {
    const api = createSettingsApi();
    render(<Settings api={api} />);
    const workers = await screen.findByLabelText("Workers");

    fireEvent.change(workers, { target: { value: String(count) } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save delivery tuning" }),
    );
    fireEvent.submit(workers.closest("form") as HTMLFormElement);

    expect(workers).toBeInvalid();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workers must be between 1 and 32.",
    );
    expect(api.saveTransferPreferences).not.toHaveBeenCalled();
  });

  it("accepts zero retries", async () => {
    const api = createSettingsApi();
    render(<Settings api={api} />);

    fireEvent.change(await screen.findByLabelText("Maximum retries"), {
      target: { value: "0" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save delivery tuning" }),
    );

    await waitFor(() =>
      expect(api.saveTransferPreferences).toHaveBeenCalledWith({
        ...DEFAULT_TRANSFER_PREFERENCES,
        deliveryTuning: {
          ...DEFAULT_TRANSFER_PREFERENCES.deliveryTuning,
          maxRetries: 0,
        },
      }),
    );
  });
});
