import { useEffect, useRef, useState } from "react";

import type {
  AcquisitionEvent,
  SelectedXSource,
  XAcquisitionApi,
} from "../desktop-api";
import type {
  DestinationSummary,
  TransferPreview,
} from "../workflow";

interface XAcquisitionProps {
  api: XAcquisitionApi;
  source: SelectedXSource;
  destination: DestinationSummary;
  createAcquisitionId?: () => string;
  onEvent?: (event: AcquisitionEvent) => void;
  onPreview: (preview: TransferPreview) => void;
  onRunningChange?: (running: boolean) => void;
  onChooseAnotherSource: () => void;
}

type ViewState =
  | { step: "idle" }
  | {
      step: "running";
      acquisitionId: string;
      phase: "bookmarks" | "folders";
      completed: number;
      total: number | null;
    }
  | { step: "cancelled" }
  | { step: "resumable" }
  | {
      step: "failed";
      previousSnapshotAvailable: boolean;
      message: string;
    };

const compatibilityMessage =
  "X bookmark acquisition is temporarily incompatible. An app update may be required.";

function safeFailureMessage(event: Extract<AcquisitionEvent, { type: "failed" }>) {
  if (event.code === "xCompatibility") return compatibilityMessage;
  if (event.code === "sourceUnavailable") {
    return "The selected browser profile is no longer available.";
  }
  return "X bookmark acquisition could not be completed.";
}

export default function XAcquisition({
  api,
  source,
  destination,
  createAcquisitionId = () => crypto.randomUUID(),
  onEvent,
  onPreview,
  onRunningChange,
  onChooseAnotherSource,
}: XAcquisitionProps) {
  const [view, setView] = useState<ViewState>({ step: "idle" });
  const [cancellationError, setCancellationError] = useState<string | null>(
    null,
  );
  const unlisten = useRef<(() => void) | null>(null);
  const terminalReceived = useRef(false);

  useEffect(
    () => () => {
      unlisten.current?.();
    },
    [],
  );

  const loadPreview = async () => {
    try {
      onPreview(await api.previewXSnapshot(destination));
    } catch {
      setView({
        step: "failed",
        previousSnapshotAvailable: false,
        message: "The private X Bookmark Snapshot could not be previewed.",
      });
    }
  };

  const handleEvent = (event: AcquisitionEvent) => {
    onEvent?.(event);
    switch (event.type) {
      case "progress":
        setView({
          step: "running",
          acquisitionId: event.acquisitionId,
          phase: event.phase,
          completed: event.completed,
          total: event.total,
        });
        break;
      case "completed":
        setCancellationError(null);
        terminalReceived.current = true;
        unlisten.current?.();
        unlisten.current = null;
        void loadPreview().finally(() => onRunningChange?.(false));
        break;
      case "resumable":
        setCancellationError(null);
        onRunningChange?.(false);
        terminalReceived.current = true;
        unlisten.current?.();
        unlisten.current = null;
        setView({ step: "resumable" });
        break;
      case "cancelled":
        setCancellationError(null);
        onRunningChange?.(false);
        terminalReceived.current = true;
        unlisten.current?.();
        unlisten.current = null;
        setView({ step: "cancelled" });
        break;
      case "failed":
        setCancellationError(null);
        onRunningChange?.(false);
        terminalReceived.current = true;
        unlisten.current?.();
        unlisten.current = null;
        setView({
          step: "failed",
          previousSnapshotAvailable: event.previousSnapshotAvailable,
          message: safeFailureMessage(event),
        });
        break;
    }
  };

  const start = async () => {
    const acquisitionId = createAcquisitionId();
    terminalReceived.current = false;
    setCancellationError(null);
    onRunningChange?.(true);
    setView({
      step: "running",
      acquisitionId,
      phase: "bookmarks",
      completed: 0,
      total: null,
    });
    try {
      const stopListening = await api.startXAcquisition(
        {
          acquisitionId,
          source: {
            browserId: source.browserId,
            profileId: source.profileId,
          },
        },
        handleEvent,
      );
      if (terminalReceived.current) {
        stopListening();
      } else {
        unlisten.current = stopListening;
      }
    } catch {
      onRunningChange?.(false);
      setView({
        step: "failed",
        previousSnapshotAvailable: false,
        message: "X bookmark acquisition could not be started.",
      });
    }
  };

  const cancel = async () => {
    if (view.step !== "running") return;
    setCancellationError(null);
    try {
      await api.cancelXAcquisition(view.acquisitionId);
    } catch {
      if (!terminalReceived.current) {
        setCancellationError(
          "The cancellation request could not be sent. Acquisition is still running.",
        );
      }
    }
  };

  const progress =
    view.step === "running"
      ? view.phase === "bookmarks"
        ? `Retrieved ${view.completed} bookmark records`
        : `Read ${view.completed}${
            view.total === null ? "" : ` of ${view.total}`
          } X folders`
      : "";

  return (
    <section className="source-card" aria-labelledby="x-acquisition-title">
      <p className="eyebrow">Bookmark Snapshot</p>
      <h2 id="x-acquisition-title">Retrieve bookmarks from X</h2>
      <p>
        Bookmark records and X folder membership stay in private local app
        storage. Image and video files are not downloaded.
      </p>

      {view.step === "running" ? (
        <>
          <p role="status">{progress}</p>
          <button type="button" onClick={() => void cancel()}>
            Cancel acquisition
          </button>
        </>
      ) : (
        <button type="button" onClick={() => void start()}>
          {view.step === "resumable"
            ? "Resume acquisition"
            : "Acquire X bookmarks"}
        </button>
      )}

      {view.step === "cancelled" ? (
        <p role="status">
          Acquisition cancelled. The previous snapshot is unchanged.
        </p>
      ) : null}
      {view.step === "resumable" ? (
        <p role="status">
          Acquisition paused before it finished. Select Resume acquisition to
          continue from the saved progress.
        </p>
      ) : null}
      {cancellationError ? <p role="alert">{cancellationError}</p> : null}
      {view.step === "failed" ? (
        <div role="alert">
          <p>{view.message}</p>
          {view.previousSnapshotAvailable ? (
            <button type="button" onClick={() => void loadPreview()}>
              Use previous snapshot
            </button>
          ) : null}
        </div>
      ) : null}
      {view.step !== "running" ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={onChooseAnotherSource}
        >
          Choose another source
        </button>
      ) : null}
    </section>
  );
}
