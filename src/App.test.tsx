import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import type {
  DesktopApi,
  FileSourceApi,
  XAcquisitionApi,
} from "./desktop-api";
import {
  DEFAULT_TRANSFER_PREFERENCES,
  type SettingsApi,
} from "./settings-api";
import { defaultTransferOptions } from "./workflow";
import type { DeliveryEvent, TransferApi } from "./transfer-api";

type AppApi = DesktopApi & FileSourceApi;

const rememberedDestination = {
  serverUrl: "https://keep.example",
  userId: "user-1",
  displayName: "Ada Example",
  email: "ada@example.com",
  insecureHttp: false,
};

function settingsApi(): SettingsApi {
  return {
    transferPreferences: vi
      .fn()
      .mockResolvedValue(DEFAULT_TRANSFER_PREFERENCES),
    saveTransferPreferences: vi
      .fn()
      .mockImplementation((settings) => Promise.resolve(settings)),
    inspectPrivateData: vi.fn().mockResolvedValue({
      dataDirectory: "/Application Support/Karakeep Transfer",
      snapshotBytes: 0,
      acquisitionStateBytes: 0,
      ledgerBytes: 0,
      totalBytes: 0,
    }),
    replaceXSource: vi.fn().mockResolvedValue(undefined),
    deleteLocalTransferData: vi.fn().mockResolvedValue(undefined),
    exportDiagnostics: vi.fn().mockResolvedValue({
      generatedByUserAction: true,
      includesBookmarkContent: false,
      telemetryEnabled: false,
      versions: {
        app: "0.1.0",
        fieldTheory: "1.3.22",
        node: "22.20.0",
        schema: "1",
        karakeepBaseline: "0.32.0",
      },
      source: "ready",
      destination: "ready",
      storage: {
        dataDirectory: "[redacted]",
        snapshotBytes: 0,
        ledgerBytes: 0,
      },
      lastFailure: null,
    }),
    saveDiagnostics: vi.fn().mockResolvedValue(false),
    versionInformation: vi.fn().mockResolvedValue({
      app: "0.1.0",
      fieldTheory: "1.3.22",
      node: "22.20.0",
      schema: "1",
      karakeepBaseline: "0.32.0",
    }),
    manualUpdateCheck: vi.fn(),
  };
}

function xAcquisitionApi(): XAcquisitionApi {
  return {
    startXAcquisition: vi.fn(),
    cancelXAcquisition: vi.fn(),
    previewXSnapshot: vi.fn(),
  };
}

function transferApi(
  overrides: Partial<TransferApi> = {},
): TransferApi {
  return {
    previewTransfer: vi.fn(),
    startDelivery: vi.fn(),
    cancelDelivery: vi.fn(),
    ...overrides,
  };
}

describe("Karakeep Transfer shell", () => {
  function desktopApi(
    health: DesktopApi["health"],
    overrides: Partial<AppApi> = {},
  ): AppApi {
    return {
      health,
      discoverXSources: vi.fn().mockResolvedValue({ browsers: [] }),
      selectXSource: vi.fn(),
      selectFileSource: vi.fn().mockResolvedValue(null),
      previewFileSource: vi.fn(),
      destinationStatus: vi.fn().mockResolvedValue(null),
      connectDestination: vi.fn(),
      forgetDestination: vi.fn(),
      ...overrides,
    };
  }

  it("shows a checking state while the desktop bridge responds", () => {
    const api = desktopApi(
      vi.fn().mockReturnValue(new Promise<never>(() => undefined)),
    );

    render(<App desktopApi={api} />);

    expect(
      screen.getByRole("status", { name: "Checking desktop bridge" }),
    ).toBeInTheDocument();
  });

  it("shows the branded desktop shell after the backend health check", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
    );

    render(<App desktopApi={api} />);

    expect(
      screen.getByRole("heading", { name: "Karakeep Transfer" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("status", {
        name: "Desktop bridge ready, version 0.1.0",
      }),
    ).toBeInTheDocument();
  });

  it("reports when the desktop bridge is unavailable", async () => {
    const api = desktopApi(
      vi.fn().mockRejectedValue(new Error("bridge unavailable")),
    );

    render(<App desktopApi={api} />);

    expect(
      await screen.findByRole("status", {
        name: "Desktop bridge unavailable",
      }),
    ).toBeInTheDocument();
  });

  it("does not inspect private sources before a destination is connected", async () => {
    const discoverXSources = vi.fn().mockResolvedValue({ browsers: [] });
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      { discoverXSources },
    );

    render(<App desktopApi={api} />);

    expect(
      await screen.findByRole("heading", { name: "Connect Karakeep" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "Choose where your bookmarks live",
      }),
    ).not.toBeInTheDocument();
    expect(discoverXSources).not.toHaveBeenCalled();
  });

  it("advances a remembered destination to an explicit source choice", async () => {
    const discoverXSources = vi.fn().mockResolvedValue({ browsers: [] });
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi
          .fn()
          .mockResolvedValue(rememberedDestination),
        discoverXSources,
      },
    );

    render(<App desktopApi={api} />);

    expect(
      await screen.findByRole("heading", { name: "Choose a bookmark source" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ada Example")).toBeInTheDocument();
    expect(discoverXSources).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Use my X Source" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Choose where your bookmarks live",
      }),
    ).toBeInTheDocument();
    expect(discoverXSources).toHaveBeenCalledOnce();
  });

  it("offers the one-run file source only after the user chooses it", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi
          .fn()
          .mockResolvedValue(rememberedDestination),
      },
    );

    render(<App desktopApi={api} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use a bookmark file",
      }),
    );

    expect(
      screen.getByRole("heading", { name: "Preview a bookmark file" }),
    ).toBeInTheDocument();
  });

  it("blocks delivery until a changed transfer option has a fresh preview", async () => {
    const filePreview = {
      format: "fieldTheoryJsonl" as const,
      bookmarks: [
        {
          sourceId: "1",
          url: "https://x.com/example/status/1",
          title: "Saved post",
          note: "Post text",
          createdAt: "2024-01-02T03:04:05Z",
          tags: ["Reading"],
          folders: ["Reading"],
        },
      ],
    };
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        selectFileSource: vi
          .fn()
          .mockResolvedValue("/private/selected/bookmarks.jsonl"),
        previewFileSource: vi.fn().mockResolvedValue(filePreview),
      },
    );
    const destination = {
      serverUrl: rememberedDestination.serverUrl,
      userId: rememberedDestination.userId,
      userName: rememberedDestination.displayName,
    };
    const preview = {
      approvalId: "file-approval-1",
      total: 3,
      pending: 3,
      previouslyDelivered: 0,
      folders: ["Reading"],
      destination,
    };
    let resolvePreview: (value: typeof preview) => void = () => {};
    const refreshedPreview = new Promise<typeof preview>((resolve) => {
      resolvePreview = resolve;
    });
    const deliveryApi = transferApi({
      previewTransfer: vi
        .fn()
        .mockResolvedValueOnce(preview)
        .mockReturnValueOnce(refreshedPreview),
      startDelivery: vi.fn().mockResolvedValue(() => {}),
    });

    render(
      <App
        desktopApi={api}
        transferApi={deliveryApi}
        createDeliveryId={() => "delivery-limited"}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a bookmark file" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue with 1 bookmark" }),
    );
    await screen.findByRole("heading", { name: "Review this transfer" });

    fireEvent.change(screen.getByLabelText("Limit this run to"), {
      target: { value: "1" },
    });

    expect(screen.getByRole("button", { name: "Start transfer" })).toBeDisabled();
    resolvePreview({ ...preview, approvalId: "file-approval-2", pending: 1 });

    await waitFor(() =>
      expect(screen.getByLabelText("Transfer summary")).toHaveTextContent(
        "Pending1",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm transfer" }));

    await waitFor(() =>
      expect(deliveryApi.startDelivery).toHaveBeenCalledWith(
        {
          approvalId: "file-approval-2",
          deliveryId: "delivery-limited",
          source: {
            kind: "file",
            path: "/private/selected/bookmarks.jsonl",
            format: "fieldTheoryJsonl",
          },
          options: { ...defaultTransferOptions, limit: 1 },
        },
        expect.any(Function),
      ),
    );
  });

  it("previews and delivers a selected file through the guided transfer", async () => {
    const filePreview = {
      format: "fieldTheoryJsonl" as const,
      bookmarks: [
        {
          sourceId: "bookmark-1",
          url: "https://x.com/example/status/1",
          title: "Saved post",
          note: "",
          createdAt: null,
          tags: ["twitter", "Reading"],
          folders: ["Reading"],
        },
      ],
    };
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        selectFileSource: vi
          .fn()
          .mockResolvedValue("/private/selected/bookmarks.jsonl"),
        previewFileSource: vi.fn().mockResolvedValue(filePreview),
      },
    );
    let publish: ((event: DeliveryEvent) => void) | undefined;
    const stopListening = vi.fn();
    const deliveryApi = transferApi({
      previewTransfer: vi.fn().mockResolvedValue({
        approvalId: "file-approval-1",
        total: 1,
        pending: 1,
        previouslyDelivered: 0,
        folders: ["Reading"],
        destination: {
          serverUrl: rememberedDestination.serverUrl,
          userId: rememberedDestination.userId,
          userName: rememberedDestination.displayName,
        },
      }),
      startDelivery: vi.fn().mockImplementation(async (_request, onEvent) => {
        publish = onEvent;
        return stopListening;
      }),
    });

    render(
      <App
        desktopApi={api}
        transferApi={deliveryApi}
        createDeliveryId={() => "delivery-1"}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a bookmark file" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue with 1 bookmark",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Review this transfer" }),
    ).toBeInTheDocument();
    expect(deliveryApi.previewTransfer).toHaveBeenCalledWith(
      {
        kind: "file",
        path: "/private/selected/bookmarks.jsonl",
        format: "fieldTheoryJsonl",
      },
      defaultTransferOptions,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm transfer" }),
    );
    await waitFor(() =>
      expect(deliveryApi.startDelivery).toHaveBeenCalledWith(
        {
          approvalId: "file-approval-1",
          deliveryId: "delivery-1",
          source: {
            kind: "file",
            path: "/private/selected/bookmarks.jsonl",
            format: "fieldTheoryJsonl",
          },
          options: defaultTransferOptions,
        },
        expect.any(Function),
      ),
    );

    act(() => {
      publish?.({
        type: "progress",
        deliveryId: "delivery-1",
        progress: { completed: 1, total: 1 },
      });
    });
    expect(
      screen.getByRole("progressbar", {
        name: "1 of 1 bookmarks processed",
      }),
    ).toBeInTheDocument();

    act(() => {
      publish?.({
        type: "completed",
        deliveryId: "delivery-1",
        result: {
          delivered: 1,
          created: 1,
          existing: 0,
          retried: 0,
          failed: 0,
          cancelled: 0,
        },
      });
    });
    expect(
      screen.getByRole("heading", { name: "Delivery finished" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Delivered").nextSibling).toHaveTextContent("1");
    expect(stopListening).toHaveBeenCalledOnce();
  });

  it("cancels the active delivery and retries only its pending result", async () => {
    let publish: ((event: DeliveryEvent) => void) | undefined;
    const deliveryApi = transferApi({
      previewTransfer: vi.fn().mockResolvedValue({
        total: 2,
        pending: 2,
        previouslyDelivered: 0,
        folders: [],
        destination: {
          serverUrl: rememberedDestination.serverUrl,
          userId: rememberedDestination.userId,
          userName: rememberedDestination.displayName,
        },
      }),
      startDelivery: vi.fn().mockImplementation(async (_request, onEvent) => {
        publish = onEvent;
        return vi.fn();
      }),
      cancelDelivery: vi.fn().mockResolvedValue(undefined),
    });
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        selectFileSource: vi.fn().mockResolvedValue("/private/bookmarks.html"),
        previewFileSource: vi.fn().mockResolvedValue({
          format: "chromeNetscape",
          bookmarks: [
            {
              sourceId: "bookmark-1",
              url: "https://example.com/1",
              title: "One",
              note: "",
              createdAt: null,
              tags: ["chrome"],
              folders: [],
            },
            {
              sourceId: "bookmark-2",
              url: "https://example.com/2",
              title: "Two",
              note: "",
              createdAt: null,
              tags: ["chrome"],
              folders: [],
            },
          ],
        }),
      },
    );

    render(
      <App
        desktopApi={api}
        transferApi={deliveryApi}
        createDeliveryId={vi.fn()
          .mockReturnValueOnce("delivery-cancel")
          .mockReturnValueOnce("delivery-retry")}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a bookmark file" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue with 2 bookmarks",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Start transfer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm transfer" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel transfer" }),
    );

    expect(deliveryApi.cancelDelivery).toHaveBeenCalledWith(
      "delivery-cancel",
    );

    act(() => {
      publish?.({
        type: "cancelled",
        deliveryId: "delivery-cancel",
        result: {
          delivered: 1,
          created: 1,
          existing: 0,
          retried: 0,
          failed: 0,
          cancelled: 1,
        },
      });
    });
    expect(
      screen.getByRole("heading", { name: "Delivery finished" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry 1 pending" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry 1 pending" }),
    );

    expect(deliveryApi.startDelivery).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveryId: "delivery-retry", retryOf: "delivery-cancel" }),
      expect.any(Function),
    );
    expect(
      screen.getByRole("progressbar", {
        name: "0 of 1 bookmarks processed",
      }),
    ).toBeInTheDocument();
  });

  it("reports a redacted file preview error with a source reset route", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        selectFileSource: vi.fn().mockResolvedValue("/private/bookmarks.jsonl"),
        previewFileSource: vi.fn().mockResolvedValue({
          format: "fieldTheoryJsonl",
          bookmarks: [
            {
              sourceId: "one",
              url: "https://example.com/one",
              title: "One",
              note: "",
              createdAt: null,
              tags: [],
              folders: [],
            },
          ],
        }),
      },
    );
    const deliveryApi = transferApi({
      previewTransfer: vi
        .fn()
        .mockRejectedValue(new Error("private backend detail")),
    });

    render(<App desktopApi={api} transferApi={deliveryApi} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a bookmark file" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue with 1 bookmark",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The transfer preview could not be prepared. Choose the file again.",
    );
    expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another source" }),
    );

    expect(
      screen.getByRole("heading", { name: "Choose a bookmark source" }),
    ).toBeInTheDocument();
  });

  it("returns safely to the preview when delivery startup fails", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        selectFileSource: vi.fn().mockResolvedValue("/private/bookmarks.jsonl"),
        previewFileSource: vi.fn().mockResolvedValue({
          format: "fieldTheoryJsonl",
          bookmarks: [
            {
              sourceId: "one",
              url: "https://example.com/one",
              title: "One",
              note: "",
              createdAt: null,
              tags: [],
              folders: [],
            },
          ],
        }),
      },
    );
    const deliveryApi = transferApi({
      previewTransfer: vi.fn().mockResolvedValue({
        total: 1,
        pending: 1,
        previouslyDelivered: 0,
        folders: [],
        destination: {
          serverUrl: rememberedDestination.serverUrl,
          userId: rememberedDestination.userId,
          userName: rememberedDestination.displayName,
        },
      }),
      startDelivery: vi
        .fn()
        .mockRejectedValue(new Error("credential-and-path-canary")),
    });

    render(
      <App
        desktopApi={api}
        transferApi={deliveryApi}
        createDeliveryId={() => "delivery-start-failure"}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a bookmark file" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue with 1 bookmark",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Start transfer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm transfer" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Delivery could not be started. Check the connection and try again.",
    );
    expect(
      screen.getByRole("heading", { name: "Review this transfer" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("credential-and-path-canary"),
    ).not.toBeInTheDocument();
  });

  it("handles rejected cancellation and a redacted terminal failure", async () => {
    let publish: ((event: DeliveryEvent) => void) | undefined;
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        selectFileSource: vi.fn().mockResolvedValue("/private/bookmarks.html"),
        previewFileSource: vi.fn().mockResolvedValue({
          format: "chromeNetscape",
          bookmarks: [
            {
              sourceId: "one",
              url: "https://example.com/one",
              title: "One",
              note: "",
              createdAt: null,
              tags: [],
              folders: [],
            },
          ],
        }),
      },
    );
    const deliveryApi = transferApi({
      previewTransfer: vi.fn().mockResolvedValue({
        total: 1,
        pending: 1,
        previouslyDelivered: 0,
        folders: [],
        destination: {
          serverUrl: rememberedDestination.serverUrl,
          userId: rememberedDestination.userId,
          userName: rememberedDestination.displayName,
        },
      }),
      startDelivery: vi.fn().mockImplementation(async (_request, onEvent) => {
        publish = onEvent;
        return vi.fn();
      }),
      cancelDelivery: vi
        .fn()
        .mockRejectedValue(new Error("private cancellation detail")),
    });

    render(
      <App
        desktopApi={api}
        transferApi={deliveryApi}
        createDeliveryId={() => "delivery-terminal-failure"}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a bookmark file" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose and preview file" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Continue with 1 bookmark",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Start transfer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm transfer" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel transfer" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The cancellation request could not be sent.",
    );

    act(() => {
      publish?.({
        type: "failed",
        deliveryId: "delivery-terminal-failure",
        code: "network",
        result: {
          delivered: 0,
          created: 0,
          existing: 0,
          retried: 0,
          failed: 1,
          cancelled: 0,
        },
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Karakeep could not be reached. Check the connection and try again.",
    );
    expect(
      screen.getByRole("heading", { name: "Delivery finished" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Delivered").nextSibling).toHaveTextContent("0");
    expect(
      screen.getByRole("button", { name: "Retry 1 pending" }),
    ).toBeInTheDocument();
  });

  it("advances a confirmed X Source to snapshot acquisition", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi
          .fn()
          .mockResolvedValue(rememberedDestination),
        discoverXSources: vi.fn().mockResolvedValue({
          browsers: [
            {
              id: "chrome",
              name: "Google Chrome",
              profiles: [{ id: "Default", name: "Personal" }],
            },
          ],
        }),
        selectXSource: vi.fn().mockResolvedValue({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Default",
          profileName: "Personal",
        }),
      },
    );

    render(
      <App
        desktopApi={api}
        xAcquisitionApi={xAcquisitionApi()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use my X Source",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use this X Source" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Retrieve bookmarks from X",
      }),
    ).toBeInTheDocument();
  });

  it("returns an idle selected X Source to the source choice", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        discoverXSources: vi.fn().mockResolvedValue({
          browsers: [
            {
              id: "chrome",
              name: "Google Chrome",
              profiles: [{ id: "Default", name: "Personal" }],
            },
          ],
        }),
        selectXSource: vi.fn().mockResolvedValue({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Default",
          profileName: "Personal",
        }),
      },
    );

    render(<App desktopApi={api} xAcquisitionApi={xAcquisitionApi()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use my X Source" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use this X Source" }),
    );
    await screen.findByRole("heading", { name: "Retrieve bookmarks from X" });
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another source" }),
    );

    expect(
      screen.getByRole("heading", { name: "Choose a bookmark source" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Retrieve bookmarks from X" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Settings unavailable while X acquisition is active", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        discoverXSources: vi.fn().mockResolvedValue({
          browsers: [
            {
              id: "chrome",
              name: "Google Chrome",
              profiles: [{ id: "Default", name: "Personal" }],
            },
          ],
        }),
        selectXSource: vi.fn().mockResolvedValue({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Default",
          profileName: "Personal",
        }),
      },
    );
    let acquisitionEvent:
      | Parameters<XAcquisitionApi["startXAcquisition"]>[1]
      | undefined;
    let acquisitionId = "";
    const acquisitionApi: XAcquisitionApi = {
      startXAcquisition: vi
        .fn()
        .mockImplementation(async (request, onEvent) => {
          acquisitionId = request.acquisitionId;
          acquisitionEvent = onEvent;
          return vi.fn();
        }),
      cancelXAcquisition: vi.fn(),
      previewXSnapshot: vi.fn(),
    };

    render(<App desktopApi={api} xAcquisitionApi={acquisitionApi} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Use my X Source" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use this X Source" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(acquisitionApi.startXAcquisition).toHaveBeenCalledOnce(),
    );

    expect(
      screen.getByRole("button", { name: "Open Settings" }),
    ).toBeDisabled();

    act(() => {
      acquisitionEvent?.({ type: "cancelled", acquisitionId });
    });
    expect(
      screen.getByRole("button", { name: "Open Settings" }),
    ).toBeEnabled();
  });

  it("returns to source choice after replacing the retained X Source", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        discoverXSources: vi.fn().mockResolvedValue({
          browsers: [
            {
              id: "chrome",
              name: "Google Chrome",
              profiles: [{ id: "Default", name: "Personal" }],
            },
          ],
        }),
        selectXSource: vi.fn().mockResolvedValue({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Default",
          profileName: "Personal",
        }),
      },
    );
    const localSettings = settingsApi();
    let acquisitionEvent:
      | Parameters<XAcquisitionApi["startXAcquisition"]>[1]
      | undefined;
    let acquisitionId = "";
    const acquisitionApi: XAcquisitionApi = {
      startXAcquisition: vi
        .fn()
        .mockImplementation(async (request, onEvent) => {
          acquisitionId = request.acquisitionId;
          acquisitionEvent = onEvent;
          return vi.fn();
        }),
      cancelXAcquisition: vi.fn(),
      previewXSnapshot: vi.fn().mockResolvedValue({
        total: 1,
        pending: 1,
        previouslyDelivered: 0,
        folders: [],
        destination: {
          serverUrl: rememberedDestination.serverUrl,
          userId: rememberedDestination.userId,
          userName: rememberedDestination.displayName,
        },
      }),
    };

    render(
      <App
        desktopApi={api}
        settingsApi={localSettings}
        xAcquisitionApi={acquisitionApi}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use my X Source" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use this X Source" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(acquisitionApi.startXAcquisition).toHaveBeenCalledOnce(),
    );
    act(() => {
      acquisitionEvent?.({
        type: "completed",
        acquisitionId,
        total: 1,
        added: 1,
        folders: [],
      });
    });
    expect(
      await screen.findByRole("heading", { name: "Review this transfer" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace X Source" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm source replacement" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Choose a bookmark source" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Review this transfer" }),
    ).not.toBeInTheDocument();
  });

  it("resets the selected source and closes Settings after local data deletion", async () => {
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        discoverXSources: vi.fn().mockResolvedValue({
          browsers: [
            {
              id: "chrome",
              name: "Google Chrome",
              profiles: [{ id: "Default", name: "Personal" }],
            },
          ],
        }),
        selectXSource: vi.fn().mockResolvedValue({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Default",
          profileName: "Personal",
        }),
      },
    );
    const localSettings = settingsApi();

    render(
      <App
        desktopApi={api}
        settingsApi={localSettings}
        xAcquisitionApi={xAcquisitionApi()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use my X Source" }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use this X Source" }),
    );
    await screen.findByRole("heading", { name: "Retrieve bookmarks from X" });
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Delete local transfer data",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm local data deletion" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Choose a bookmark source" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  it("refreshes an acquired X review after source tags change in Settings", async () => {
    let acquisitionEvent:
      | Parameters<XAcquisitionApi["startXAcquisition"]>[1]
      | undefined;
    let acquisitionId = "";
    const xPreview = {
      approvalId: "approval-x",
      total: 2,
      pending: 1,
      previouslyDelivered: 1,
      folders: ["Reading"],
      destination: {
        serverUrl: rememberedDestination.serverUrl,
        userId: rememberedDestination.userId,
        userName: rememberedDestination.displayName,
      },
    };
    const acquisitionApi: XAcquisitionApi = {
      startXAcquisition: vi
        .fn()
        .mockImplementation(async (request, onEvent) => {
          acquisitionId = request.acquisitionId;
          acquisitionEvent = onEvent;
          return vi.fn();
        }),
      cancelXAcquisition: vi.fn(),
      previewXSnapshot: vi.fn().mockResolvedValue(xPreview),
    };
    const deliveryApi = transferApi({
      previewTransfer: vi.fn().mockResolvedValue({
        ...xPreview,
        approvalId: "approval-x-refreshed",
      }),
      startDelivery: vi.fn().mockResolvedValue(vi.fn()),
    });
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi.fn().mockResolvedValue(rememberedDestination),
        discoverXSources: vi.fn().mockResolvedValue({
          browsers: [
            {
              id: "chrome",
              name: "Google Chrome",
              profiles: [{ id: "Default", name: "Personal" }],
            },
          ],
        }),
        selectXSource: vi.fn().mockResolvedValue({
          browserId: "chrome",
          browserName: "Google Chrome",
          profileId: "Default",
          profileName: "Personal",
        }),
      },
    );

    render(
      <App
        desktopApi={api}
        settingsApi={settingsApi()}
        xAcquisitionApi={acquisitionApi}
        transferApi={deliveryApi}
        createDeliveryId={() => "delivery-x"}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use my X Source",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use this X Source" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(acquisitionApi.startXAcquisition).toHaveBeenCalledOnce(),
    );

    act(() => {
      acquisitionEvent?.({
        type: "completed",
        acquisitionId,
        total: 2,
        added: 2,
        folders: ["Reading"],
      });
    });
    expect(
      await screen.findByRole("heading", { name: "Review this transfer" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "twitter, for X bookmarks" }),
    );
    await screen.findByText(
      "Settings were saved and apply to the next transfer run.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to transfer" }));
    expect(deliveryApi.previewTransfer).toHaveBeenCalledWith(
      { kind: "x" },
      defaultTransferOptions,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start transfer" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm transfer" }),
    );
    await waitFor(() =>
      expect(deliveryApi.startDelivery).toHaveBeenCalledWith(
        {
          approvalId: "approval-x-refreshed",
          deliveryId: "delivery-x",
          source: { kind: "x" },
          options: defaultTransferOptions,
        },
        expect.any(Function),
      ),
    );
  });

  it("opens Settings and can forget the active destination", async () => {
    const forgetDestination = vi.fn().mockResolvedValue(undefined);
    const api = desktopApi(
      vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
      {
        destinationStatus: vi
          .fn()
          .mockResolvedValueOnce(rememberedDestination)
          .mockResolvedValue(null),
        forgetDestination,
      },
    );

    render(<App desktopApi={api} settingsApi={settingsApi()} />);
    await screen.findByRole("heading", { name: "Choose a bookmark source" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Settings" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Forget Karakeep connection" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm forgetting connection",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Connect Karakeep" }),
    ).toBeInTheDocument();
    expect(forgetDestination).toHaveBeenCalledOnce();
  });
});
