import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import type {
  DesktopApi,
  FileSourceApi,
  XAcquisitionApi,
} from "./desktop-api";
import type { SettingsApi } from "./settings-api";

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
      screen.getByRole("button", { name: "Use my X browser session" }),
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

  it("advances a confirmed X source to snapshot acquisition", async () => {
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
        name: "Use my X browser session",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use this X source" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Retrieve bookmarks from X",
      }),
    ).toBeInTheDocument();
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
