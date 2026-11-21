import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import XAcquisition from "./XAcquisition";
import type {
  AcquisitionEvent,
  XAcquisitionApi,
} from "../desktop-api";

const source = {
  browserId: "chrome",
  browserName: "Google Chrome",
  profileId: "Default",
  profileName: "Personal",
};

const destination = {
  serverUrl: "https://keep.example",
  userId: "user-7",
  userName: "Reader",
};

function controlledApi() {
  let emit: ((event: AcquisitionEvent) => void) | undefined;
  const api: XAcquisitionApi = {
    startXAcquisition: vi.fn(async (_request, onEvent) => {
      emit = onEvent;
      return () => {};
    }),
    cancelXAcquisition: vi.fn().mockResolvedValue(undefined),
    previewXSnapshot: vi.fn().mockResolvedValue({
      total: 2,
      pending: 1,
      previouslyDelivered: 1,
      folders: ["Research"],
      destination,
    }),
  };
  return {
    api,
    emit: (event: AcquisitionEvent) => {
      if (!emit) throw new Error("acquisition listener not installed");
      emit(event);
    },
  };
}

describe("X acquisition", () => {
  it("offers another source before acquisition begins", () => {
    const controlled = controlledApi();
    const onChooseAnotherSource = vi.fn();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        onPreview={() => {}}
        onChooseAnotherSource={onChooseAnotherSource}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose another source" }),
    );

    expect(onChooseAnotherSource).toHaveBeenCalledOnce();
  });

  it("does not offer another source while acquisition is running", async () => {
    const controlled = controlledApi();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        onPreview={() => {}}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalledOnce(),
    );

    expect(
      screen.queryByRole("button", { name: "Choose another source" }),
    ).not.toBeInTheDocument();
  });

  it("offers another source after acquisition is cancelled", async () => {
    const controlled = controlledApi();
    const onChooseAnotherSource = vi.fn();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-cancelled-switch"}
        onPreview={() => {}}
        onChooseAnotherSource={onChooseAnotherSource}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalledOnce(),
    );

    controlled.emit({
      type: "cancelled",
      acquisitionId: "acquire-ui-cancelled-switch",
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose another source" }),
    );

    expect(onChooseAnotherSource).toHaveBeenCalledOnce();
  });

  it("pauses a throttled acquisition without previewing partial data and resumes explicitly", async () => {
    const controlled = controlledApi();
    const onPreview = vi.fn();
    const onRunningChange = vi.fn();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-resume"}
        onPreview={onPreview}
        onRunningChange={onRunningChange}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalledOnce(),
    );
    controlled.emit({
      type: "resumable",
      acquisitionId: "acquire-ui-resume",
      reason: "rateLimited",
    });

    expect(
      await screen.findByText(/resume acquisition to continue from the saved progress/i),
    ).toBeInTheDocument();
    expect(onPreview).not.toHaveBeenCalled();
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Resume acquisition" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalledTimes(2),
    );
  });

  it("describes the runtime ceiling as a neutral resumable pause", async () => {
    const controlled = controlledApi();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-runtime-resume"}
        onPreview={() => {}}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalledOnce(),
    );
    controlled.emit({
      type: "resumable",
      acquisitionId: "acquire-ui-runtime-resume",
      reason: "maxRuntime",
    });

    expect(
      await screen.findByText(/acquisition paused before it finished/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/X paused the acquisition/i)).toBeNull();
  });

  it("offers another source after acquisition fails", async () => {
    const controlled = controlledApi();
    const onChooseAnotherSource = vi.fn();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-failed-switch"}
        onPreview={() => {}}
        onChooseAnotherSource={onChooseAnotherSource}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalledOnce(),
    );

    controlled.emit({
      type: "failed",
      acquisitionId: "acquire-ui-failed-switch",
      code: "sourceUnavailable",
      message: "private source details",
      previousSnapshotAvailable: false,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose another source" }),
    );

    expect(onChooseAnotherSource).toHaveBeenCalledOnce();
  });

  it("reports structured progress and yields a read-only Transfer Preview", async () => {
    const controlled = controlledApi();
    const onPreview = vi.fn();
    const onEvent = vi.fn();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-1"}
        onEvent={onEvent}
        onPreview={onPreview}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalled(),
    );
    controlled.emit({
      type: "progress",
      acquisitionId: "acquire-ui-1",
      phase: "bookmarks",
      completed: 40,
      total: null,
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Retrieved 40 bookmark records",
      ),
    );
    controlled.emit({
      type: "completed",
      acquisitionId: "acquire-ui-1",
      total: 42,
      added: 2,
      folders: ["Research"],
    });

    await waitFor(() =>
      expect(onPreview).toHaveBeenCalledWith({
        total: 2,
        pending: 1,
        previouslyDelivered: 1,
        folders: ["Research"],
        destination,
      }),
    );
    expect(onEvent).toHaveBeenLastCalledWith({
      type: "completed",
      acquisitionId: "acquire-ui-1",
      total: 42,
      added: 2,
      folders: ["Research"],
    });
  });

  it("lets the user cancel the active acquisition", async () => {
    const controlled = controlledApi();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-cancel"}
        onPreview={() => {}}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel acquisition" }));

    expect(controlled.api.cancelXAcquisition).toHaveBeenCalledWith(
      "acquire-ui-cancel",
    );
  });

  it("keeps acquisition visible and reports a safe error when cancellation is rejected", async () => {
    const controlled = controlledApi();
    vi.mocked(controlled.api.cancelXAcquisition).mockRejectedValue(
      new Error("private cancellation detail"),
    );
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-cancel-error"}
        onPreview={() => {}}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel acquisition" }));

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(
      "The cancellation request could not be sent. Acquisition is still running.",
    );
    expect(
      screen.getByRole("button", { name: "Cancel acquisition" }),
    ).toBeInTheDocument();
    controlled.emit({
      type: "progress",
      acquisitionId: "acquire-ui-cancel-error",
      phase: "bookmarks",
      completed: 1,
      total: null,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Acquisition is still running.",
    );
    expect(screen.queryByText("private cancellation detail")).toBeNull();
  });

  it("keeps the previous snapshot available after an X compatibility failure", async () => {
    const controlled = controlledApi();
    const onPreview = vi.fn();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-failure"}
        onPreview={onPreview}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalled(),
    );
    controlled.emit({
      type: "failed",
      acquisitionId: "acquire-ui-failure",
      code: "xCompatibility",
      message: "GraphQL failed with auth-token-canary-acquisition-8472",
      previousSnapshotAvailable: true,
    });

    expect(
      await screen.findByText(/an app update may be required/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/auth-token-canary-acquisition-8472/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Use previous snapshot" }),
    );

    await waitFor(() => expect(onPreview).toHaveBeenCalled());
  });

  it("confirms that cancellation leaves the prior snapshot unchanged", async () => {
    const controlled = controlledApi();
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-cancelled"}
        onPreview={() => {}}
        onChooseAnotherSource={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalled(),
    );

    controlled.emit({
      type: "cancelled",
      acquisitionId: "acquire-ui-cancelled",
    });

    expect(
      await screen.findByText(
        "Acquisition cancelled. The previous snapshot is unchanged.",
      ),
    ).toBeInTheDocument();
  });

  it("reports a safe error when the retained snapshot cannot be previewed", async () => {
    const controlled = controlledApi();
    vi.mocked(controlled.api.previewXSnapshot).mockRejectedValue(
      new Error("private path details"),
    );
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-preview-error"}
        onPreview={() => {}}
        onChooseAnotherSource={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );
    await waitFor(() =>
      expect(controlled.api.startXAcquisition).toHaveBeenCalled(),
    );

    controlled.emit({
      type: "completed",
      acquisitionId: "acquire-ui-preview-error",
      total: 2,
      added: 1,
      folders: [],
    });

    expect(
      await screen.findByText(
        "The private X Bookmark Snapshot could not be previewed.",
      ),
    ).toBeInTheDocument();
  });

  it("reports a safe error when acquisition cannot start", async () => {
    const controlled = controlledApi();
    vi.mocked(controlled.api.startXAcquisition).mockRejectedValue(
      new Error("auth-token-canary-acquisition-8472"),
    );
    render(
      <XAcquisition
        api={controlled.api}
        source={source}
        createAcquisitionId={() => "acquire-ui-start-error"}
        onPreview={() => {}}
        onChooseAnotherSource={() => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Acquire X bookmarks" }),
    );

    expect(
      await screen.findByText("X bookmark acquisition could not be started."),
    ).toBeInTheDocument();
  });
});
