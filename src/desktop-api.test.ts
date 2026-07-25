import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import { desktopApi, type HealthResponse } from "./desktop-api";

describe("desktop API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
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
});
