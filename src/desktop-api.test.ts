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
});
