import { useEffect, useReducer, useRef, useState } from "react";

import { desktopApi as defaultDesktopApi } from "./desktop-api";
import type {
  DesktopApi,
  DestinationSummary,
  FileSourceApi,
  HealthResponse,
  SelectedXSource,
  XAcquisitionApi,
} from "./desktop-api";
import { xAcquisitionApi as defaultXAcquisitionApi } from "./desktop-api";
import FileSourcePanel from "./FileSourcePanel";
import type { FileSourceSelection } from "./FileSourcePanel";
import Settings from "./Settings";
import {
  settingsDesktopApi as defaultSettingsApi,
  type SettingsApi,
} from "./settings-api";
import XSourceSetup from "./x-source/XSourceSetup";
import XAcquisition from "./x-source/XAcquisition";
import DestinationSetup from "./DestinationSetup";
import TransferReview from "./TransferReview";
import {
  transferApi as defaultTransferApi,
  type DeliveryEvent,
  type DeliveryFailureCode,
  type TransferApi,
  type TransferSourceRequest,
} from "./transfer-api";
import {
  defaultTransferOptions,
  type TransferOptions,
  type TransferPreview,
  type TransferProgress,
  type TransferResult,
} from "./workflow";

type AppDesktopApi = DesktopApi & FileSourceApi;
type SourceMode = "x" | "file" | null;
type ReadySource =
  | { kind: "x"; source: SelectedXSource }
  | { kind: "file"; selection: FileSourceSelection };
type WorkflowPhase =
  | "destination"
  | "source-choice"
  | "source-setup"
  | "acquisition"
  | "acquisition-running"
  | "acquisition-cancelled"
  | "acquisition-failed"
  | "preview-preparation"
  | "preview"
  | "delivery"
  | "result"
  | "failure";

interface WorkflowState {
  phase: WorkflowPhase;
  destination: DestinationSummary | null;
  sourceMode: SourceMode;
  readySource: ReadySource | null;
  deliverySource: TransferSourceRequest | null;
  transferPreview: TransferPreview | null;
  transferProgress: TransferProgress | null;
  transferResult: TransferResult | null;
  transferError: string | null;
}

type WorkflowAction =
  | { type: "destination.connected"; destination: DestinationSummary }
  | { type: "destination.forgotten" }
  | { type: "source.mode-selected"; mode: Exclude<SourceMode, null> }
  | { type: "source.x-selected"; source: SelectedXSource }
  | {
      type: "file.preview-started";
      selection: FileSourceSelection;
      source: TransferSourceRequest;
    }
  | {
      type: "preview.ready";
      preview: TransferPreview;
      source: TransferSourceRequest;
    }
  | { type: "preview.failed"; message: string }
  | { type: "acquisition.running-changed"; running: boolean }
  | { type: "acquisition.cancelled" }
  | { type: "acquisition.failed" }
  | { type: "delivery.started"; total: number }
  | { type: "delivery.retry-started"; total: number }
  | { type: "delivery.progressed"; progress: TransferProgress }
  | { type: "delivery.completed"; result: TransferResult }
  | { type: "delivery.cancelled"; result: TransferResult }
  | {
      type: "delivery.failed";
      preview: TransferPreview;
      message: string;
      result: TransferResult;
    }
  | {
      type: "delivery.start-failed";
      message: string;
      result: TransferResult | null;
    }
  | { type: "delivery.cancellation-request-failed"; message: string }
  | { type: "source.reset" };

const initialWorkflowState: WorkflowState = {
  phase: "destination",
  destination: null,
  sourceMode: null,
  readySource: null,
  deliverySource: null,
  transferPreview: null,
  transferProgress: null,
  transferResult: null,
  transferError: null,
};

function workflowReducer(
  state: WorkflowState,
  action: WorkflowAction,
): WorkflowState {
  switch (action.type) {
    case "destination.connected":
      return {
        ...initialWorkflowState,
        phase: "source-choice",
        destination: action.destination,
      };
    case "destination.forgotten":
      return initialWorkflowState;
    case "source.mode-selected":
      return {
        ...state,
        phase: "source-setup",
        sourceMode: action.mode,
      };
    case "source.x-selected":
      return {
        ...state,
        phase: "acquisition",
        readySource: { kind: "x", source: action.source },
      };
    case "file.preview-started":
      return {
        ...state,
        phase: "preview-preparation",
        readySource: { kind: "file", selection: action.selection },
        deliverySource: action.source,
        transferError: null,
      };
    case "preview.ready":
      return {
        ...state,
        phase: "preview",
        deliverySource: action.source,
        transferPreview: action.preview,
        transferProgress: null,
        transferResult: null,
        transferError: null,
      };
    case "preview.failed":
      return {
        ...state,
        phase: "failure",
        transferPreview: null,
        transferError: action.message,
      };
    case "acquisition.running-changed":
      if (action.running) {
        return { ...state, phase: "acquisition-running" };
      }
      return state.phase === "acquisition-running"
        ? { ...state, phase: "acquisition" }
        : state;
    case "acquisition.cancelled":
      return { ...state, phase: "acquisition-cancelled" };
    case "acquisition.failed":
      return { ...state, phase: "acquisition-failed" };
    case "delivery.started":
    case "delivery.retry-started":
      return {
        ...state,
        phase: "delivery",
        transferProgress: {
          completed: 0,
          total: action.total,
        },
        transferResult: null,
        transferError: null,
      };
    case "delivery.progressed":
      return {
        ...state,
        transferProgress: action.progress,
      };
    case "delivery.completed":
    case "delivery.cancelled":
      return {
        ...state,
        phase: "result",
        transferProgress: null,
        transferResult: action.result,
      };
    case "delivery.failed":
      return {
        ...state,
        phase: "failure",
        transferPreview: action.preview,
        transferProgress: null,
        transferResult: action.result,
        transferError: action.message,
      };
    case "delivery.start-failed":
      return {
        ...state,
        phase: "failure",
        transferProgress: null,
        transferResult: action.result,
        transferError: action.message,
      };
    case "delivery.cancellation-request-failed":
      return {
        ...state,
        transferError: action.message,
      };
    case "source.reset":
      return {
        ...initialWorkflowState,
        phase: state.destination ? "source-choice" : "destination",
        destination: state.destination,
      };
  }
}

interface AppProps {
  desktopApi?: AppDesktopApi;
  settingsApi?: SettingsApi;
  xAcquisitionApi?: XAcquisitionApi;
  transferApi?: TransferApi;
  createDeliveryId?: () => string;
}

export default function App({
  desktopApi = defaultDesktopApi,
  settingsApi = defaultSettingsApi,
  xAcquisitionApi = defaultXAcquisitionApi,
  transferApi = defaultTransferApi,
  createDeliveryId = () => crypto.randomUUID(),
}: AppProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [workflow, dispatch] = useReducer(
    workflowReducer,
    initialWorkflowState,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [transferOptions, setTransferOptions] = useState<TransferOptions>(
    defaultTransferOptions,
  );
  const [repreviewing, setRepreviewing] = useState(false);
  const {
    destination,
    sourceMode,
    readySource,
    transferPreview,
    deliverySource,
    transferProgress,
    transferResult,
    transferError,
  } = workflow;
  const preparingPreview = workflow.phase === "preview-preparation";
  const acquisitionActive = workflow.phase === "acquisition-running";
  const activeDelivery = useRef<{
    id: string;
    unlisten?: () => void;
  } | null>(null);
  const lastDelivery = useRef<string | null>(null);
  const terminalDeliveries = useRef(new Set<string>());

  useEffect(() => {
    let active = true;

    desktopApi.health().then(
      (response) => {
        if (active) {
          setHealth(response);
        }
      },
      () => {
        if (active) {
          setHealthFailed(true);
        }
      },
    );

    return () => {
      active = false;
    };
  }, [desktopApi]);

  useEffect(
    () => () => {
      activeDelivery.current?.unlisten?.();
    },
    [],
  );

  function chooseAnotherSource() {
    activeDelivery.current?.unlisten?.();
    activeDelivery.current = null;
    lastDelivery.current = null;
    setTransferOptions(defaultTransferOptions);
    dispatch({ type: "source.reset" });
  }

  /// A changed option changes what would be delivered, so the reviewed preview
  /// is replaced before it can be confirmed.
  async function changeTransferOptions(options: TransferOptions) {
    if (!deliverySource) return;
    setRepreviewing(true);
    setTransferOptions(options);
    try {
      dispatch({
        type: "preview.ready",
        preview: await transferApi.previewTransfer(deliverySource, options),
        source: deliverySource,
      });
    } catch {
      setTransferOptions(defaultTransferOptions);
      dispatch({
        type: "preview.failed",
        message:
          "The transfer preview could not be prepared for those options.",
      });
    } finally {
      setRepreviewing(false);
    }
  }

  async function prepareFileTransfer(selection: FileSourceSelection) {
    const source: TransferSourceRequest = {
      kind: "file",
      path: selection.path,
      format: selection.preview.format,
    };
    dispatch({ type: "file.preview-started", selection, source });
    try {
      dispatch({
        type: "preview.ready",
        preview: await transferApi.previewTransfer(source, transferOptions),
        source,
      });
    } catch {
      dispatch({
        type: "preview.failed",
        message:
          "The transfer preview could not be prepared. Choose the file again.",
      });
    }
  }

  function handleDeliveryEvent(
    deliveryId: string,
    preview: TransferPreview,
    event: DeliveryEvent,
  ) {
    if (event.deliveryId !== deliveryId) return;
    if (event.type === "progress") {
      dispatch({ type: "delivery.progressed", progress: event.progress });
      return;
    }

    const currentDelivery = activeDelivery.current;
    if (
      currentDelivery?.id === deliveryId &&
      currentDelivery.unlisten !== undefined
    ) {
      currentDelivery.unlisten();
    } else {
      terminalDeliveries.current.add(deliveryId);
    }
    activeDelivery.current = null;
    lastDelivery.current = deliveryId;
    if (event.type === "completed") {
      dispatch({ type: "delivery.completed", result: event.result });
      return;
    }
    if (event.type === "cancelled") {
      dispatch({ type: "delivery.cancelled", result: event.result });
      return;
    }

    dispatch({
      type: "delivery.failed",
      preview,
      message: deliveryFailureMessage(event.code),
      result: event.result,
    });
  }

  async function startDelivery(retry = false) {
    if (
      repreviewing ||
      !deliverySource ||
      !transferPreview ||
      activeDelivery.current
    ) return;
    const retryOf = retry ? lastDelivery.current : null;
    if (retry && !retryOf) return;
    const deliveryId = createDeliveryId();
    const preview = transferPreview;
    dispatch({
      type: retry ? "delivery.retry-started" : "delivery.started",
      total:
        retry && transferResult
          ? transferResult.failed + transferResult.cancelled
          : preview.pending,
    });
    activeDelivery.current = { id: deliveryId };
    try {
      const unlisten = await transferApi.startDelivery(
        {
          ...(preview.approvalId
            ? { approvalId: preview.approvalId }
            : {}),
          deliveryId,
          ...(retryOf ? { retryOf } : {}),
          source: deliverySource,
          options: transferOptions,
        },
        (event) => handleDeliveryEvent(deliveryId, preview, event),
      );
      if (terminalDeliveries.current.delete(deliveryId)) {
        unlisten();
      } else if (activeDelivery.current?.id === deliveryId) {
        activeDelivery.current.unlisten = unlisten;
      } else {
        unlisten();
      }
    } catch {
      activeDelivery.current = null;
      dispatch({
        type: "delivery.start-failed",
        result: retry ? transferResult : null,
        message:
          "Delivery could not be started. Check the connection and try again.",
      });
    }
  }

  async function cancelDelivery() {
    const deliveryId = activeDelivery.current?.id;
    if (!deliveryId) return;
    try {
      await transferApi.cancelDelivery(deliveryId);
    } catch {
      dispatch({
        type: "delivery.cancellation-request-failed",
        message:
          "The cancellation request could not be sent. Delivery will stop as soon as possible.",
      });
    }
  }

  const status = health
    ? {
        label: `Desktop bridge ready, version ${health.version}`,
        text: `Desktop bridge ready · v${health.version}`,
        tone: "ready",
      }
    : healthFailed
      ? {
          label: "Desktop bridge unavailable",
          text: "Desktop bridge unavailable",
          tone: "error",
        }
      : {
          label: "Checking desktop bridge",
          text: "Checking desktop bridge…",
          tone: "checking",
        };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <img src="/favicon.png" alt="" width="36" height="36" />
          <h1>Karakeep Transfer</h1>
        </div>
        <div className="app-header-actions">
          <p
            className={`bridge-status bridge-status--${status.tone}`}
            role="status"
            aria-label={status.label}
          >
            <span className="status-dot" aria-hidden="true" />
            {status.text}
          </p>
          {health ? (
            <button
              type="button"
              className="settings-link"
              disabled={
                transferProgress !== null ||
                acquisitionActive ||
                preparingPreview ||
                repreviewing
              }
              onClick={() => setShowSettings(!showSettings)}
            >
              {showSettings ? "Back to transfer" : "Open Settings"}
            </button>
          ) : null}
        </div>
      </header>

      {health && !showSettings && !destination ? (
        <DestinationSetup
          desktopApi={desktopApi}
          onReady={(nextDestination) =>
            dispatch({
              type: "destination.connected",
              destination: nextDestination,
            })
          }
        />
      ) : null}

      {health && destination && !showSettings && sourceMode === null ? (
        <section className="source-card" aria-labelledby="source-choice-title">
          <p className="eyebrow">Step 2 · Source</p>
          <h2 id="source-choice-title">Choose a bookmark source</h2>
          <p className="source-explanation">
            Connected to <strong>{destination.displayName}</strong> at{" "}
            {destination.serverUrl}. Choose the source for this transfer.
          </p>
          <div className="source-choice-actions">
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "source.mode-selected", mode: "x" })
              }
            >
              Use my X Source
            </button>
            <button
              type="button"
              onClick={() =>
                dispatch({ type: "source.mode-selected", mode: "file" })
              }
            >
              Use a bookmark file
            </button>
          </div>
        </section>
      ) : null}

      {health &&
      destination &&
      !showSettings &&
      sourceMode === "x" &&
      !readySource ? (
        <XSourceSetup
          api={desktopApi}
          onSelected={(source) =>
            dispatch({ type: "source.x-selected", source })
          }
          onChooseAnotherSource={chooseAnotherSource}
        />
      ) : null}

      {health &&
      destination &&
      !showSettings &&
      sourceMode === "file" &&
      !readySource ? (
        <FileSourcePanel
          api={desktopApi}
          onContinue={(selection) => void prepareFileTransfer(selection)}
          onChooseAnotherSource={chooseAnotherSource}
        />
      ) : null}

      {health &&
      destination &&
      !showSettings &&
      readySource?.kind === "x" &&
      !transferPreview ? (
        <XAcquisition
          api={xAcquisitionApi}
          source={readySource.source}
          onPreview={(preview) => {
            dispatch({
              type: "preview.ready",
              preview,
              source: { kind: "x" },
            });
          }}
          onEvent={(event) => {
            if (event.type === "cancelled") {
              dispatch({ type: "acquisition.cancelled" });
            } else if (event.type === "failed") {
              dispatch({ type: "acquisition.failed" });
            }
          }}
          onRunningChange={(running) =>
            dispatch({ type: "acquisition.running-changed", running })
          }
          onChooseAnotherSource={chooseAnotherSource}
        />
      ) : null}

      {health &&
      destination &&
      !showSettings &&
      readySource?.kind === "file" &&
      preparingPreview ? (
        <section className="source-card" aria-live="polite">
          <p>Preparing the transfer preview…</p>
        </section>
      ) : null}

      {health && destination && !showSettings && transferError ? (
        <section className="source-card">
          <p role="alert">{transferError}</p>
          {workflow.phase === "failure" &&
          readySource?.kind === "file" &&
          !transferPreview ? (
            <button type="button" onClick={chooseAnotherSource}>
              Choose another source
            </button>
          ) : null}
        </section>
      ) : null}

      {health &&
      destination &&
      !showSettings &&
      transferPreview &&
      transferResult ? (
        <TransferReview
          phase="result"
          result={transferResult}
          onRetryPending={() => void startDelivery(true)}
          onChooseAnotherSource={chooseAnotherSource}
        />
      ) : health &&
        destination &&
        !showSettings &&
        transferPreview &&
        transferProgress ? (
        <TransferReview
          phase="progress"
          progress={transferProgress}
          onCancel={() => void cancelDelivery()}
        />
      ) : health &&
        destination &&
        !showSettings &&
        transferPreview ? (
        <TransferReview
          phase="preview"
          preview={transferPreview}
          options={transferOptions}
          optionsBusy={repreviewing}
          onOptionsChange={(options) => void changeTransferOptions(options)}
          onStart={() => void startDelivery()}
          onChooseAnotherSource={chooseAnotherSource}
        />
      ) : null}

      {health && showSettings ? (
        <Settings
          api={settingsApi}
          onXSourceReplaced={() => {
            chooseAnotherSource();
            setShowSettings(false);
          }}
          onLocalDataDeleted={() => {
            chooseAnotherSource();
            setShowSettings(false);
          }}
          onForgetKarakeepConnection={
            destination
              ? async () => {
                  await desktopApi.forgetDestination();
                  dispatch({ type: "destination.forgotten" });
                  setShowSettings(false);
                }
              : undefined
          }
        />
      ) : null}

      <footer>
        <p>Unofficial community tool · No telemetry</p>
      </footer>
    </main>
  );
}

function deliveryFailureMessage(code: DeliveryFailureCode): string {
  switch (code) {
    case "destination-authentication":
      return "Reconnect Karakeep before retrying delivery.";
    case "destination-compatibility":
      return "This Karakeep server is missing a required delivery capability.";
    case "network":
      return "Karakeep could not be reached. Check the connection and try again.";
    case "delivery-failed":
      return "Delivery stopped before all pending bookmarks were processed.";
    case "unexpected":
      return "Delivery could not be completed. You can safely retry pending bookmarks.";
  }
}
