import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DestinationSetup from "./DestinationSetup";
import type {
  ConnectDestinationInput,
  DestinationApi,
  DestinationSummary,
} from "./desktop-api";

const connectedDestination: DestinationSummary = {
  serverUrl: "https://keep.example",
  userId: "user-1",
  displayName: "Ada Example",
  email: "ada@example.com",
  insecureHttp: false,
};

function destinationApi(
  overrides: Partial<DestinationApi> = {},
): DestinationApi {
  return {
    destinationStatus: vi.fn().mockResolvedValue(null),
    connectDestination: vi.fn().mockResolvedValue(connectedDestination),
    forgetDestination: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function completeForm(
  server = "https://keep.example",
  apiKey = "transient-canary-key",
) {
  fireEvent.change(screen.getByLabelText("Karakeep server"), {
    target: { value: server },
  });
  fireEvent.change(screen.getByLabelText("Karakeep API key"), {
    target: { value: apiKey },
  });
}

describe("Destination connection", () => {
  it("returns to a remembered ready state without asking for the key", async () => {
    const api = destinationApi({
      destinationStatus: vi.fn().mockResolvedValue(connectedDestination),
    });
    const onReady = vi.fn();

    render(<DestinationSetup desktopApi={api} onReady={onReady} />);

    expect(
      await screen.findByRole("heading", { name: "Ada Example" }),
    ).toBeInTheDocument();
    expect(onReady).toHaveBeenCalledWith(connectedDestination);
    expect(screen.getByText("https://keep.example")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Karakeep API key"),
    ).not.toBeInTheDocument();
  });

  it("connects with a transient key and displays the authenticated destination", async () => {
    const connectDestination = vi
      .fn<(input: ConnectDestinationInput) => Promise<DestinationSummary>>()
      .mockResolvedValue(connectedDestination);
    const api = destinationApi({ connectDestination });

    const onReady = vi.fn();
    render(<DestinationSetup desktopApi={api} onReady={onReady} />);
    await screen.findByLabelText("Karakeep API key");
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect Karakeep" }));

    await waitFor(() => {
      expect(connectDestination).toHaveBeenCalledWith({
        server: "https://keep.example",
        apiKey: "transient-canary-key",
        allowInsecureHttp: false,
      });
    });
    expect(
      await screen.findByRole("heading", { name: "Ada Example" }),
    ).toBeInTheDocument();
    expect(onReady).toHaveBeenCalledWith(connectedDestination);
    expect(
      screen.queryByDisplayValue("transient-canary-key"),
    ).not.toBeInTheDocument();
  });

  it("keeps authentication failures recoverable and clears the rejected key", async () => {
    const api = destinationApi({
      connectDestination: vi.fn().mockRejectedValue({
        code: "authentication",
        message: "Karakeep rejected the API key. Check the key and try again.",
      }),
    });

    render(<DestinationSetup desktopApi={api} />);
    await screen.findByLabelText("Karakeep API key");
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect Karakeep" }));

    expect(
      await screen.findByRole("alert", {
        name: "Karakeep connection failed",
      }),
    ).toHaveTextContent("Karakeep rejected the API key");
    expect(screen.getByLabelText("Karakeep API key")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Connect Karakeep" }),
    ).toBeEnabled();
  });

  it("maps backend failures to approved copy without exposing arbitrary details", async () => {
    const api = destinationApi({
      connectDestination: vi.fn().mockRejectedValue({
        code: "authentication",
        message:
          "backend-canary-api-key-and-private-path-/private/canary/bookmarks",
      }),
    });

    render(<DestinationSetup desktopApi={api} />);
    await screen.findByLabelText("Karakeep API key");
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect Karakeep" }));

    expect(
      await screen.findByRole("alert", {
        name: "Karakeep connection failed",
      }),
    ).toHaveTextContent(
      "Karakeep rejected the API key. Check the key and try again.",
    );
    expect(screen.queryByText(/backend-canary/)).not.toBeInTheDocument();
  });

  it("explains how to recover when the system credential store denies access", async () => {
    const api = destinationApi({
      connectDestination: vi.fn().mockRejectedValue({ code: "credential_vault" }),
    });

    render(<DestinationSetup desktopApi={api} />);
    await screen.findByLabelText("Karakeep API key");
    completeForm();
    fireEvent.click(screen.getByRole("button", { name: "Connect Karakeep" }));

    expect(
      await screen.findByRole("alert", { name: "Karakeep connection failed" }),
    ).toHaveTextContent(
      "Unlock your credential store and allow Karakeep Transfer access, then try again.",
    );
  });

  it("requires an explicit warning acknowledgement for non-loopback HTTP", async () => {
    const connectDestination = vi
      .fn<(input: ConnectDestinationInput) => Promise<DestinationSummary>>()
      .mockResolvedValue({
        ...connectedDestination,
        serverUrl: "http://keep.private",
        insecureHttp: true,
      });
    const api = destinationApi({ connectDestination });

    render(<DestinationSetup desktopApi={api} />);
    await screen.findByLabelText("Karakeep API key");
    completeForm("http://keep.private");
    fireEvent.click(
      screen.getByLabelText(
        "Allow this private-network destination to receive the API key over HTTP",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Karakeep" }));

    await waitFor(() => {
      expect(connectDestination).toHaveBeenCalledWith({
        server: "http://keep.private",
        apiKey: "transient-canary-key",
        allowInsecureHttp: true,
      });
    });
  });

  it("forgets the remembered destination and returns to setup", async () => {
    const forgetDestination = vi.fn().mockResolvedValue(undefined);
    const api = destinationApi({
      destinationStatus: vi.fn().mockResolvedValue(connectedDestination),
      forgetDestination,
    });

    render(<DestinationSetup desktopApi={api} />);
    await screen.findByRole("heading", { name: "Ada Example" });
    fireEvent.click(
      screen.getByRole("button", { name: "Forget Karakeep connection" }),
    );

    expect(
      await screen.findByRole("button", { name: "Connect Karakeep" }),
    ).toBeInTheDocument();
    expect(forgetDestination).toHaveBeenCalledOnce();
  });
});
