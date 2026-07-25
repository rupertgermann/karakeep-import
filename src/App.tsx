import { useEffect, useState } from "react";

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
import type { TransferPreview } from "./workflow";

type AppDesktopApi = DesktopApi & FileSourceApi;
type SourceMode = "x" | "file" | null;
type ReadySource =
  | { kind: "x"; source: SelectedXSource }
  | { kind: "file"; selection: FileSourceSelection };

interface AppProps {
  desktopApi?: AppDesktopApi;
  settingsApi?: SettingsApi;
  xAcquisitionApi?: XAcquisitionApi;
}

export default function App({
  desktopApi = defaultDesktopApi,
  settingsApi = defaultSettingsApi,
  xAcquisitionApi = defaultXAcquisitionApi,
}: AppProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [destination, setDestination] =
    useState<DestinationSummary | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>(null);
  const [readySource, setReadySource] = useState<ReadySource | null>(null);
  const [transferPreview, setTransferPreview] =
    useState<TransferPreview | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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
          onContinue={(selection) =>
            setReadySource({ kind: "file", selection })
          }
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
          onPreview={setTransferPreview}
        />
      ) : null}

      {health &&
      destination &&
      !showSettings &&
      readySource?.kind === "file" ? (
        <section className="source-card" aria-labelledby="source-ready-title">
          <p className="eyebrow">Step 3 · Preview</p>
          <h2 id="source-ready-title">Bookmark file ready</h2>
          <p className="source-explanation">
            {readySource.selection.preview.bookmarks.length} bookmarks are
            ready to preview.
          </p>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setReadySource(null);
              setSourceMode(null);
              setTransferPreview(null);
            }}
          >
            Choose another source
          </button>
        </section>
      ) : null}

      {health && destination && !showSettings && transferPreview ? (
        <section className="source-card" aria-labelledby="transfer-preview-title">
          <p className="eyebrow">Step 4 · Confirm</p>
          <h2 id="transfer-preview-title">Review this transfer</h2>
          <p className="source-explanation">
            {transferPreview.pending} of {transferPreview.total} bookmarks are
            pending for {transferPreview.destination.userName}.{" "}
            {transferPreview.previouslyDelivered} were delivered previously.
          </p>
        </section>
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
                    setTransferPreview(null);
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
