import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import type { DesktopApi } from "./desktop-api";

describe("Karakeep Transfer shell", () => {
  it("shows a checking state while the desktop bridge responds", () => {
    const desktopApi: DesktopApi = {
      health: vi.fn().mockReturnValue(new Promise<never>(() => undefined)),
    };

    render(<App desktopApi={desktopApi} />);

    expect(
      screen.getByRole("status", { name: "Checking desktop bridge" }),
    ).toBeInTheDocument();
  });

  it("shows the branded desktop shell after the backend health check", async () => {
    const desktopApi: DesktopApi = {
      health: vi.fn().mockResolvedValue({
        status: "ok",
        appName: "Karakeep Transfer",
        version: "0.1.0",
      }),
    };

    render(<App desktopApi={desktopApi} />);

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
    const desktopApi: DesktopApi = {
      health: vi.fn().mockRejectedValue(new Error("bridge unavailable")),
    };

    render(<App desktopApi={desktopApi} />);

    expect(
      await screen.findByRole("status", {
        name: "Desktop bridge unavailable",
      }),
    ).toBeInTheDocument();
  });
});
