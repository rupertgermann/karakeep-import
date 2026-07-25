import { useEffect, useRef, useState } from "react";

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
import type {
  TransferPreview,
  TransferProgress,
  TransferResult,
} from "./workflow";

type AppDesktopApi = DesktopApi & FileSourceApi;
type SourceMode = "x" | "file" | null;
type ReadySource =
  | { kind: "x"; source: SelectedXSource }
  | { kind: "file"; selection: FileSourceSelection };

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
  const [destination, setDestination] =
    useState<DestinationSummary | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>(null);
  const [readySource, setReadySource] = useState<ReadySource | null>(null);
  const [transferPreview, setTransferPreview] =
    useState<TransferPreview | null>(null);
  const [deliverySource, setDeliverySource] =
    useState<TransferSourceRequest | null>(null);
  const [transferProgress, setTransferProgress] =
    useState<TransferProgress | null>(null);
  const [transferResult, setTransferResult] =
    useState<TransferResult | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const activeDelivery = useRef<{
    id: string;
    unlisten?: () => void;
  } | null>(null);
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
    setSourceMode(null);
    setReadySource(null);
    setDeliverySource(null);
    setTransferPreview(null);
    setTransferProgress(null);
    setTransferResult(null);
    setTransferError(null);
    setPreparingPreview(false);
  }

  async function prepareFileTransfer(selection: FileSourceSelection) {
    const source: TransferSourceRequest = {
      kind: "file",
      path: selection.path,
      format: selection.preview.format,
    };
    setReadySource({ kind: "file", selection });
    setDeliverySource(source);
    setPreparingPreview(true);
    setTransferError(null);
    try {
      setTransferPreview(await transferApi.previewTransfer(source));
    } catch {
      setTransferError(
        "The transfer preview could not be prepared. Choose the file again.",
      );
    } finally {
      setPreparingPreview(false);
    }
  }

  function handleDeliveryEvent(
    deliveryId: string,
    preview: TransferPreview,
    event: DeliveryEvent,
  ) {
    if (event.deliveryId !== deliveryId) return;
    if (event.type === "progress") {
      setTransferProgress(event.progress);
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
    setTransferProgress(null);
    if (event.type === "completed" || event.type === "cancelled") {
      setTransferResult(event.result);
      return;
    }

    setTransferPreview(preview);
    setTransferError(deliveryFailureMessage(event.code));
  }

  async function startDelivery() {
    if (!deliverySource || !transferPreview || activeDelivery.current) return;
    const deliveryId = createDeliveryId();
    const preview = transferPreview;
    setTransferError(null);
    setTransferResult(null);
    setTransferProgress({ completed: 0, total: preview.pending });
    activeDelivery.current = { id: deliveryId };
    try {
      const unlisten = await transferApi.startDelivery(
        {
          ...(preview.approvalId
            ? { approvalId: preview.approvalId }
            : {}),
          deliveryId,
          source: deliverySource,
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
      setTransferProgress(null);
      setTransferError(
        "Delivery could not be started. Check the connection and try again.",
      );
    }
  }

  async function cancelDelivery() {
    const deliveryId = activeDelivery.current?.id;
    if (!deliveryId) return;
    try {
      await transferApi.cancelDelivery(deliveryId);
    } catch {
      setTransferError(
        "The cancellation request could not be sent. Delivery will stop as soon as possible.",
      );
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
      <section className="welcome-card" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">
          <img src="/favicon.png" alt="" width="64" height="64" />
        </div>
        <p className="eyebrow">Private bookmark transfer</p>
        <h1 id="app-title">Karakeep Transfer</h1>
        <p className="introduction">
          Move bookmarks into your Karakeep library from a quiet, local desktop
          workflow.
        </p>
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
            disabled={transferProgress !== null}
            onClick={() => setShowSettings(true)}
          >
            Open Settings
          </button>
        ) : null}
        {health && !showSettings && !destination ? (
          <DestinationSetup
            desktopApi={desktopApi}
            onReady={setDestination}
          />
        ) : null}
      </section>

      {health && destination && !showSettings && sourceMode === null ? (
        <section className="source-card" aria-labelledby="source-choice-title">
          <p className="eyebrow">Step 2 · Source</p>
          <h2 id="source-choice-title">Choose a bookmark source</h2>
          <p className="source-explanation">
            Connected to <strong>{destination.displayName}</strong> at{" "}
            {destination.serverUrl}. Choose the source for this transfer.
          </p>
          <div className="source-choice-actions">
            <button type="button" onClick={() => setSourceMode("x")}>
              Use my X browser session
            </button>
            <button type="button" onClick={() => setSourceMode("file")}>
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
          onSelected={(source) => setReadySource({ kind: "x", source })}
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
          destination={{
            serverUrl: destination.serverUrl,
            userId: destination.userId,
            userName: destination.displayName,
          }}
          onPreview={(preview) => {
            setDeliverySource({ kind: "x" });
            setTransferPreview(preview);
            setTransferError(null);
          }}
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
        <p role="alert" className="source-card">
          {transferError}
        </p>
      ) : null}

      {health &&
      destination &&
      !showSettings &&
      transferPreview &&
      transferResult ? (
        <TransferReview
          phase="result"
          result={transferResult}
          onRetryPending={() => void startDelivery()}
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
          onStart={() => void startDelivery()}
          onChooseAnotherSource={chooseAnotherSource}
        />
      ) : null}

      {health && showSettings ? (
        <div className="settings-view">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setShowSettings(false)}
          >
            Back to transfer
          </button>
          <Settings
            api={settingsApi}
            onForgetKarakeepConnection={
              destination
                ? async () => {
                    await desktopApi.forgetDestination();
                    setDestination(null);
                    setSourceMode(null);
                    setReadySource(null);
                    setDeliverySource(null);
                    setTransferPreview(null);
                    setTransferProgress(null);
                    setTransferResult(null);
                    setShowSettings(false);
                  }
                : undefined
            }
          />
        </div>
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
