import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import {
  DELETE_LOCAL_TRANSFER_DATA,
  REPLACE_X_SOURCE,
  SIGNED_RELEASES_URL,
  settingsDesktopApi,
} from "./settings-api";

describe("settings desktop API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("inspects private transfer data through its allowlisted command", async () => {
    mocks.invoke.mockResolvedValue({
      dataDirectory: "/Application Support/Karakeep Transfer",
      snapshotBytes: 10,
      acquisitionStateBytes: 5,
      ledgerBytes: 20,
      totalBytes: 35,
    });

    await settingsDesktopApi.inspectPrivateData();

    expect(mocks.invoke).toHaveBeenCalledWith("inspect_private_transfer_data");
  });

  it("replaces the X source with the typed confirmation token", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await settingsDesktopApi.replaceXSource(REPLACE_X_SOURCE);

    expect(mocks.invoke).toHaveBeenCalledWith("replace_x_source", {
      confirmation: "replace-x-source",
    });
  });

  it("deletes local transfer data with the typed confirmation token", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await settingsDesktopApi.deleteLocalTransferData(
      DELETE_LOCAL_TRANSFER_DATA,
    );

    expect(mocks.invoke).toHaveBeenCalledWith("delete_local_transfer_data", {
      confirmation: "delete-local-transfer-data",
    });
  });

  it("requests a redacted diagnostics export as data", async () => {
    mocks.invoke.mockResolvedValue({});

    await settingsDesktopApi.exportDiagnostics();

    expect(mocks.invoke).toHaveBeenCalledWith("export_diagnostics");
  });

  it.each([true, false])(
    "reports whether the native diagnostics Save dialog completed: %s",
    async (saved) => {
      mocks.invoke.mockResolvedValue(saved);

      await expect(settingsDesktopApi.saveDiagnostics()).resolves.toBe(saved);

      expect(mocks.invoke).toHaveBeenCalledWith("save_diagnostics");
    },
  );

  it("requests component versions from the desktop backend", async () => {
    mocks.invoke.mockResolvedValue({});

    await settingsDesktopApi.versionInformation();

    expect(mocks.invoke).toHaveBeenCalledWith("version_information");
  });

  it("checks for updates only through a user-triggered command", async () => {
    mocks.invoke.mockResolvedValue({
      requestedByUser: true,
      releasePage: SIGNED_RELEASES_URL,
      downloadsUpdate: false,
      executesUpdate: false,
    });

    await settingsDesktopApi.manualUpdateCheck();

    expect(mocks.invoke).toHaveBeenCalledWith("manual_update_check");
  });

  it("rejects an update destination outside the signed release allowlist", async () => {
    mocks.invoke.mockResolvedValue({
      requestedByUser: true,
      releasePage: "https://example.invalid/download",
      downloadsUpdate: false,
      executesUpdate: false,
    });

    await expect(settingsDesktopApi.manualUpdateCheck()).rejects.toThrow(
      "The update destination is not allowlisted.",
    );
  });
});
