import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

import {
  desktopApi,
  type DestinationSummary,
  type FileSourcePreview,
  type HealthResponse,
  xAcquisitionApi,
} from "./desktop-api";

describe("desktop API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.open.mockReset();
    mocks.listen.mockReset();
  });

  it("requests health through the typed Tauri command boundary", async () => {
    const response: HealthResponse = {
      status: "ok",
      appName: "Karakeep Transfer",
      version: "0.1.0",
    };
    mocks.invoke.mockResolvedValue(response);

    await desktopApi.health();

    expect(mocks.invoke).toHaveBeenCalledWith("health");
  });

  it("returns the typed health response", async () => {
    const response: HealthResponse = {
      status: "ok",
      appName: "Karakeep Transfer",
      version: "0.1.0",
    };
    mocks.invoke.mockResolvedValue(response);

    await expect(desktopApi.health()).resolves.toEqual(response);
  });

  it("discovers X sources through the structured Tauri command", async () => {
    mocks.invoke.mockResolvedValue({ browsers: [] });

    await desktopApi.discoverXSources();

    expect(mocks.invoke).toHaveBeenCalledWith("discover_x_sources");
  });

  it("selects an X source without passing session values", async () => {
    const request = {
      consent: true as const,
      source: { browserId: "chrome", profileId: "Default" },
    };
    mocks.invoke.mockResolvedValue({
      browserId: "chrome",
      browserName: "Google Chrome",
      profileId: "Default",
      profileName: "Personal",
    });

    await desktopApi.selectXSource(request);

    expect(mocks.invoke).toHaveBeenCalledWith("select_x_source", { request });
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toMatch(
      /ct0|auth.?token|cookie/i,
    );
  });

  it("opens a native picker limited to supported File Sources", async () => {
    mocks.open.mockResolvedValue("/private/bookmarks.jsonl");

    await expect(desktopApi.selectFileSource()).resolves.toBe(
      "/private/bookmarks.jsonl",
    );
    expect(mocks.open).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "Bookmark files",
          extensions: ["jsonl", "json", "html", "htm", "txt"],
        },
      ],
    });
  });

  it("requests an in-place preview with an explicit format", async () => {
    const preview: FileSourcePreview = {
      format: "fieldTheoryJsonl",
      bookmarks: [],
    };
    mocks.invoke.mockResolvedValue(preview);

    await expect(
      desktopApi.previewFileSource(
        "/private/bookmarks.txt",
        "fieldTheoryJsonl",
      ),
    ).resolves.toEqual(preview);
    expect(mocks.invoke).toHaveBeenCalledWith("preview_file_source", {
      path: "/private/bookmarks.txt",
      format: "fieldTheoryJsonl",
    });
  });

  it("uses the destination command boundary without frontend persistence", async () => {
    const destination: DestinationSummary = {
      serverUrl: "https://keep.example",
      userId: "user-1",
      displayName: "Ada Example",
      email: "ada@example.com",
      insecureHttp: false,
    };
    mocks.invoke.mockResolvedValue(destination);

    await desktopApi.destinationStatus();
    await desktopApi.connectDestination({
      server: "https://keep.example",
      apiKey: "transient-key",
      allowInsecureHttp: false,
    });
    await desktopApi.forgetDestination();

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "destination_status");
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "connect_destination", {
      input: {
        server: "https://keep.example",
        apiKey: "transient-key",
        allowInsecureHttp: false,
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "forget_destination");
  });

  it("installs the acquisition listener before starting the bridge", async () => {
    const calls: string[] = [];
    mocks.listen.mockImplementation(async () => {
      calls.push("listen");
      return () => {};
    });
    mocks.invoke.mockImplementation(async () => {
      calls.push("invoke");
    });

    await xAcquisitionApi.startXAcquisition(
      {
        acquisitionId: "acquire-api-1",
        source: { browserId: "chrome", profileId: "Default" },
      },
      () => {},
    );

    expect(calls).toEqual(["listen", "invoke"]);
  });

  it("forwards only events for the acquisition that installed the listener", async () => {
    let listener:
      | ((event: { payload: { acquisitionId: string; type: "cancelled" } }) => void)
      | undefined;
    mocks.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return () => {};
    });
    mocks.invoke.mockResolvedValue(undefined);
    const onEvent = vi.fn();
    await xAcquisitionApi.startXAcquisition(
      {
        acquisitionId: "acquire-api-filtered",
        source: { browserId: "chrome", profileId: "Default" },
      },
      onEvent,
    );

    listener?.({
      payload: { type: "cancelled", acquisitionId: "another-acquisition" },
    });
    listener?.({
      payload: { type: "cancelled", acquisitionId: "acquire-api-filtered" },
    });

    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("removes the acquisition listener when startup fails", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);
    mocks.invoke.mockRejectedValue(new Error("bridge missing"));

    await expect(
      xAcquisitionApi.startXAcquisition(
        {
          acquisitionId: "acquire-api-error",
          source: { browserId: "chrome", profileId: "Default" },
        },
        () => {},
      ),
    ).rejects.toThrow("bridge missing");

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cancels acquisition through a typed command without session values", async () => {
    await xAcquisitionApi.cancelXAcquisition("acquire-api-1");

    expect(mocks.invoke).toHaveBeenCalledWith("cancel_x_acquisition", {
      acquisitionId: "acquire-api-1",
    });
  });

  it("requests an X Transfer Preview without starting delivery", async () => {
    mocks.invoke.mockResolvedValue({
      total: 2,
      pending: 1,
      previouslyDelivered: 1,
      folders: ["Research"],
      destination: {
        serverUrl: "https://keep.example",
        userId: "user-7",
        userName: "Reader",
      },
    });

    await xAcquisitionApi.previewXSnapshot({
      serverUrl: "https://keep.example",
      userId: "user-7",
      userName: "Reader",
    });

    expect(mocks.invoke).toHaveBeenCalledWith("preview_x_snapshot", {
      destination: {
        serverUrl: "https://keep.example",
        userId: "user-7",
        userName: "Reader",
      },
    });
  });
});
