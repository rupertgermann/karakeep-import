import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.open,
}));

import {
  desktopApi,
  type FileSourcePreview,
  type HealthResponse,
} from "./desktop-api";

describe("desktop API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.open.mockReset();
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
});
