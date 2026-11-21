import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import XSourceSetup from "./XSourceSetup";
import type { XSourceApi } from "../desktop-api";

describe("X Source setup", () => {
  it("lets the user choose a discovered profile and explicitly consent", async () => {
    const api: XSourceApi = {
      discoverXSources: vi.fn().mockResolvedValue({
        browsers: [
          {
            id: "chrome",
            name: "Google Chrome",
            profiles: [
              { id: "Default", name: "Personal" },
              { id: "Profile 2", name: "Research" },
            ],
          },
        ],
      }),
      selectXSource: vi.fn().mockResolvedValue({
        browserId: "chrome",
        browserName: "Google Chrome",
        profileId: "Profile 2",
        profileName: "Research",
      }),
    };

    const onSelected = vi.fn();
    render(
      <XSourceSetup
        api={api}
        onSelected={onSelected}
        onChooseAnotherSource={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("combobox", { name: "Browser" }),
    ).toBeInTheDocument();
    const profile = screen.getByRole("combobox", { name: "Profile" });
    profile.focus();
    fireEvent.keyDown(profile, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeVisible());
    expect(
      screen.getByRole("option", { name: "Personal", selected: true }),
    ).toBeVisible();
    const research = screen.getByRole("option", { name: "Research" });
    fireEvent.pointerDown(research);
    fireEvent.click(research);
    expect(profile).toHaveTextContent("Research");

    const confirm = screen.getByRole("button", { name: "Use this X Source" });
    expect(confirm).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(confirm);

    expect(api.selectXSource).toHaveBeenCalledWith({
      consent: true,
      source: { browserId: "chrome", profileId: "Profile 2" },
    });
    expect(
      await screen.findByRole("status", {
        name: "X Source selected: Google Chrome, Research",
      }),
    ).toBeInTheDocument();
    expect(onSelected).toHaveBeenCalledWith({
      browserId: "chrome",
      browserName: "Google Chrome",
      profileId: "Profile 2",
      profileName: "Research",
    });
  });

  it("explains when no supported browser profiles are found", async () => {
    const api: XSourceApi = {
      discoverXSources: vi.fn().mockResolvedValue({ browsers: [] }),
      selectXSource: vi.fn(),
    };

    const onChooseAnotherSource = vi.fn();
    render(
      <XSourceSetup
        api={api}
        onChooseAnotherSource={onChooseAnotherSource}
      />,
    );

    expect(
      await screen.findByText(
        /No supported browser profiles were found\. Install or open/i,
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Try discovery again" }),
    );
    await waitFor(() => expect(api.discoverXSources).toHaveBeenCalledTimes(2));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another source" }),
    );
    expect(onChooseAnotherSource).toHaveBeenCalledOnce();
  });

  it("switches browser profiles and reports an unavailable selection", async () => {
    const api: XSourceApi = {
      discoverXSources: vi.fn().mockResolvedValue({
        browsers: [
          {
            id: "chrome",
            name: "Google Chrome",
            profiles: [{ id: "Default", name: "Personal" }],
          },
          {
            id: "firefox",
            name: "Firefox",
            profiles: [
              {
                id: "Profiles/abc.default-release",
                name: "default-release",
              },
            ],
          },
        ],
      }),
      selectXSource: vi.fn().mockRejectedValue(new Error("profile moved")),
    };

    render(<XSourceSetup api={api} onChooseAnotherSource={vi.fn()} />);

    fireEvent.click(await screen.findByRole("combobox", { name: "Browser" }));
    const firefox = await screen.findByRole("option", { name: "Firefox" });
    fireEvent.pointerDown(firefox);
    fireEvent.click(firefox);
    expect(screen.getByRole("combobox", { name: "Profile" })).toHaveTextContent(
      "default-release",
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /temporarily using my existing authenticated X session/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use this X Source" }));

    expect(
      await screen.findByText(
        "The selected browser profile is no longer available.",
      ),
    ).toBeInTheDocument();
  });

  it("reports when browser discovery itself is unavailable", async () => {
    const api: XSourceApi = {
      discoverXSources: vi.fn().mockRejectedValue(new Error("bridge missing")),
      selectXSource: vi.fn(),
    };

    render(<XSourceSetup api={api} onChooseAnotherSource={vi.fn()} />);

    expect(
      await screen.findByText("Browser profile discovery is unavailable."),
    ).toBeInTheDocument();
  });
});
