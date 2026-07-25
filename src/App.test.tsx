import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import type {
  DesktopApi,
  FileSourceApi,
} from "./desktop-api";

type AppApi = DesktopApi & FileSourceApi;

const rememberedDestination = {
  serverUrl: "https://keep.example",
  userId: "user-1",
  displayName: "Ada Example",
  email: "ada@example.com",
  insecureHttp: false,
};

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
});
